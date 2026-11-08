/**
 * 全局「同步组 target」上下文。
 *
 * 模型（与 sync-target.ts 一致）：两层都是组——
 *   · 唯一的配置同步组（admin 连接的那个远端），地址 `config`；
 *   · 数据同步组（`data:<appId>:<gid>`），平铺列出，各自独立打开。
 * appId 只是配置仓内部的实现细节，不参与选择，仅在数据组行里作为次要信息。
 *
 * 负责：
 *   · 枚举可选 target（配置组 + 数据组，含尚未打开 / 描述符损坏的组）；
 *   · 解析当前选择（路径 > `?group=` > localStorage > 默认配置组）；
 *   · 选中即后台打开（同一 appId 已打开则直接切换；数据组按单个组激活）；
 *   · 打开失败时停留在失败项，暴露真实原因供页面展示 / 重试；
 *   · 给页面提供当前组的 fs、同步状态、flush、冲突等句柄。
 *
 * 兼容：旧 `config:<appId>` 归一为 `config`；旧 `?ns=` 参数直接忽略；
 * 旧的 `/@dg`、`/@adg` 深链仍然生效（路径里带组时以路径为准）。
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  AppDataBackendDescriptor,
  BackendSyncState,
  ConflictArchive,
  SyncGroupHandle,
  SyncPairStatus,
  SyncResult,
} from 'zen-fs-config';
import { useConfigRepo } from './ConfigRepoContext';
import { useRepoInstances } from './RepoInstancesContext';
import { collectDataGroupOverview, type DataGroupOverview } from '../data-group-overview';
import { parseDataGroupPath } from '../data-group-path';
import { deleteDataGroupDescriptor } from '../descriptor-cleanup';
import {
  collectSyncTargets,
  DEFAULT_SYNC_TARGET,
  DEFAULT_SYNC_TARGET_KEY,
  parseTargetKey,
  targetKey,
  type SyncTargetInstanceSnapshot,
  type SyncTargetOption,
  type SyncTargetRef,
} from '../sync-target';

const STORAGE_KEY = 'zen-fs-config-admin:selected-group';
/** 旧版本按命名空间选择的存储 key，仅用于清理，不再读取。 */
const LEGACY_NAMESPACE_STORAGE_KEY = 'zen-fs-config-admin:selected-namespace';

function safeBackendsCount(repo: unknown): number {
  try {
    const fn = (repo as { listDeclaredBackends?: () => unknown[] } | null | undefined)?.listDeclaredBackends;
    if (typeof fn !== 'function') return 0;
    const value = fn.call(repo);
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

/** 读取本地记忆，兼容旧格式（`config:<appId>` → `config`）。 */
function readStoredKey(): string {
  try {
    const ref = parseTargetKey(localStorage.getItem(STORAGE_KEY));
    if (ref) return targetKey(ref);
  } catch { /* ignore */ }
  return DEFAULT_SYNC_TARGET_KEY;
}

/** 从 Files 路径解析出 target ref（无则 null）。 */
function pathTargetRef(pathname: string): SyncTargetRef | null {
  if (!pathname.startsWith('/files')) return null;
  const rest = pathname.slice('/files'.length);
  const scope = parseDataGroupPath(rest);
  if (!scope?.groupId) return null;
  return { kind: 'data', appId: scope.appId, groupId: scope.groupId };
}

function pathTargetKey(pathname: string): string | null {
  const ref = pathTargetRef(pathname);
  return ref ? targetKey(ref) : null;
}

/** 优先级：路径 > `?group=` > localStorage > 默认配置组。 */
function resolveInitialKey(pathname: string, groupParam: string | null): string {
  const fromPath = pathTargetRef(pathname);
  if (fromPath) return targetKey(fromPath);
  const fromQuery = parseTargetKey(groupParam);
  if (fromQuery) return targetKey(fromQuery);
  return readStoredKey();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type ConflictReader = {
  listConflicts: () => Promise<ConflictArchive[]>;
  resolveConflict: (conflictId: string, mergedContent: unknown) => Promise<void>;
  readConflictBackup: (conflictId: string, fileType: 'source' | 'target' | 'resolved') => Promise<string>;
};

interface SyncTargetContextValue {
  targets: SyncTargetOption[];
  /** 分组后的展示用列表。 */
  configTargets: SyncTargetOption[];
  dataTargets: SyncTargetOption[];
  selected: SyncTargetRef;
  selectedKey: string;
  selectedOption: SyncTargetOption | null;
  /** 当前组句柄（配置组 = repo；数据组 = 已激活的组）。未打开时为 null。 */
  handle: SyncGroupHandle | null;
  /** 当前组的 fs（组根 chroot）。未打开时为 null。 */
  fs: any | null;
  ready: boolean;
  opening: boolean;
  /** 打开失败的真实原因（失败条展示）。 */
  error: string | null;
  /** 已打开实例（按 appId）。 */
  openedAppIds: string[];
  maxInstances: number;
  selectTarget: (key: string) => void;
  retry: () => void;
  switchToAdmin: () => void;
  /**
   * 删除数据组登记（两份描述符副本），写墓碑并 flush 到远端。
   * 用于描述符解析失败、无法打开的组；不动组内用户数据。
   */
  deleteDescriptor: (appId: string, groupId: string) => Promise<void>;
  flushTarget: () => Promise<SyncResult[]>;
  getSyncStatuses: () => Map<string, SyncPairStatus>;
  getBackendSyncStates: () => Map<string, BackendSyncState>;
  listDeclaredBackends: () => AppDataBackendDescriptor[];
  conflicts: ConflictReader | null;
}

const Context = createContext<SyncTargetContextValue>({
  targets: [],
  configTargets: [],
  dataTargets: [],
  selected: DEFAULT_SYNC_TARGET,
  selectedKey: DEFAULT_SYNC_TARGET_KEY,
  selectedOption: null,
  handle: null,
  fs: null,
  ready: false,
  opening: false,
  error: null,
  openedAppIds: [],
  maxInstances: 3,
  selectTarget: () => {},
  retry: () => {},
  switchToAdmin: () => {},
  deleteDescriptor: async () => {},
  flushTarget: async () => [],
  getSyncStatuses: () => new Map(),
  getBackendSyncStates: () => new Map(),
  listDeclaredBackends: () => [],
  conflicts: null,
});

export function SyncTargetProvider({ children }: { children: ReactNode }) {
  const { repo, dataGroups, refreshDataGroups } = useConfigRepo();
  const {
    instances,
    errors: instanceErrors,
    creating,
    revision,
    maxInstances,
    createInstance,
    activateGroup,
    getInstance,
  } = useRepoInstances();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [selectedKey, setSelectedKey] = useState<string>(() =>
    resolveInitialKey(location.pathname, searchParams.get('group')),
  );
  const [overview, setOverview] = useState<DataGroupOverview>({ apps: [], total: 0 });
  const [openingKeys, setOpeningKeys] = useState<Record<string, boolean>>({});
  const [failedKeys, setFailedKeys] = useState<Record<string, boolean>>({});
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  /** 已尝试过打开的 target：失败时停住，只有显式重试 / 重新选择才再试。 */
  const attemptedRef = useRef<Set<string>>(new Set());

  // 旧版本遗留的命名空间存储：不再读取，清理掉避免误导。
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_NAMESPACE_STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  // 跨 appId 描述符总览（选择器不依赖运行态即可列出未打开的组）。
  useEffect(() => {
    if (!repo) {
      setOverview({ apps: [], total: 0 });
      return;
    }
    let cancelled = false;
    const authoritativeCounts = new Map<string, number>();
    for (const g of dataGroups) {
      if (!g.error) authoritativeCounts.set(`admin/${g.id}`, g.backends?.length ?? 0);
    }
    for (const view of instances) {
      for (const g of view.groups) {
        if (!g.error) authoritativeCounts.set(`${view.appId}/${g.id}`, g.backends?.length ?? 0);
      }
    }
    collectDataGroupOverview(repo.rootFS.promises, authoritativeCounts)
      .then(res => { if (!cancelled) setOverview(res); })
      .catch(() => { if (!cancelled) setOverview({ apps: [], total: 0 }); });
    return () => { cancelled = true; };
  }, [repo, dataGroups, instances, revision]);

  // 路径优先：/files/@dg/... 或 /files/@adg/... 直接决定 target。
  useEffect(() => {
    const ref = pathTargetRef(location.pathname);
    if (!ref) return;
    setSelectedKey(targetKey(ref));
  }, [location.pathname]);

  // `?group=` 次之（路径没带组时才生效）。旧 `?ns=` 参数忽略。
  useEffect(() => {
    if (pathTargetKey(location.pathname)) return;
    const ref = parseTargetKey(searchParams.get('group'));
    if (!ref) return;
    setSelectedKey(targetKey(ref));
  }, [searchParams, location.pathname]);

  // localStorage 记忆最后一次选择（旧 `config:<appId>` 已归一为 `config`）。
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, selectedKey);
    } catch { /* ignore */ }
  }, [selectedKey]);

  const instanceSnapshots = useMemo<SyncTargetInstanceSnapshot[]>(() => {
    const list: SyncTargetInstanceSnapshot[] = [];
    if (repo) {
      const statuses = repo.getSyncStatuses();
      list.push({
        appId: 'admin',
        open: true,
        creating: false,
        backendsCount: safeBackendsCount(repo),
        pairCount: statuses.size,
        watchingCount: Array.from(statuses.values()).filter(s => s.watching).length,
        groups: dataGroups.map(g => {
          const groupStatuses = g.group && !g.error ? g.group.getSyncStatuses() : new Map();
          return {
            appId: 'admin',
            groupId: g.id,
            name: g.name,
            backendsCount: g.backends?.length ?? 0,
            pairCount: groupStatuses.size,
            watchingCount: Array.from(groupStatuses.values()).filter(s => s.watching).length,
            activated: !!g.group && !g.error,
            error: g.error,
          };
        }),
      });
    }
    for (const view of instances) {
      list.push({
        appId: view.appId,
        open: true,
        creating: !!creating[view.appId],
        backendsCount: safeBackendsCount(getInstance(view.appId)?.repo),
        pairCount: view.status.pairCount,
        watchingCount: view.status.watchingCount,
        error: instanceErrors[view.appId],
        groups: view.groups.map(g => {
          const groupStatuses = g.group && !g.error ? g.group.getSyncStatuses() : new Map();
          return {
            appId: view.appId,
            groupId: g.id,
            name: g.name,
            backendsCount: g.backends?.length ?? 0,
            pairCount: groupStatuses.size,
            watchingCount: Array.from(groupStatuses.values()).filter(s => s.watching).length,
            activated: !!g.group && !g.error,
            error: g.error,
          };
        }),
      });
    }
    for (const [appId, isCreating] of Object.entries(creating)) {
      if (!isCreating || list.some(s => s.appId === appId)) continue;
      list.push({
        appId,
        open: false,
        creating: true,
        backendsCount: 0,
        pairCount: 0,
        watchingCount: 0,
        error: instanceErrors[appId],
        groups: [],
      });
    }
    for (const [appId, err] of Object.entries(instanceErrors)) {
      if (list.some(s => s.appId === appId)) continue;
      list.push({ appId, open: false, creating: false, error: err, backendsCount: 0, pairCount: 0, watchingCount: 0, groups: [] });
    }
    return list;
  }, [repo, dataGroups, instances, creating, instanceErrors, getInstance]);

  const targets = useMemo(
    () => collectSyncTargets(overview, instanceSnapshots),
    [overview, instanceSnapshots],
  );

  const selected = useMemo<SyncTargetRef>(
    () => parseTargetKey(selectedKey) ?? DEFAULT_SYNC_TARGET,
    [selectedKey],
  );

  const selectedOption = useMemo(
    () => targets.find(t => t.key === selectedKey) ?? null,
    [targets, selectedKey],
  );

  const handle = useMemo<SyncGroupHandle | null>(() => {
    if (selected.kind === 'config') {
      // 运行时 ConfigRepo 已实现 SyncGroupHandle 的全部能力（含 listDeclaredBackends）。
      return repo as unknown as SyncGroupHandle | null;
    }
    if (selected.appId === 'admin') {
      const info = dataGroups.find(g => g.id === selected.groupId);
      return info && info.group && !info.error ? info.group : null;
    }
    // instances 每次 revision 都会重建，组激活后这里能拿到新快照。
    const info = instances.find(v => v.appId === selected.appId)?.groups.find(g => g.id === selected.groupId);
    return info && info.group && !info.error ? info.group : null;
  }, [selected, repo, dataGroups, instances]);

  const fs = useMemo(() => {
    if (!handle) return null;
    // 配置组按“配置仓根”浏览（能看到 .config / .meta / 各 appId 目录），
    // 不再用 chroot 到 /${appId} 的应用载荷视图；数据组仍用各自的组根 fs。
    const raw = selected.kind === 'config' ? (repo as any)?.rootFS : handle.fs;
    return raw?.promises ?? raw ?? null;
  }, [handle, selected.kind, repo]);

  const ready = !!handle;
  const opening = !!openingKeys[selectedKey]
    || (selected.kind === 'data' && selected.appId !== 'admin' && !!creating[selected.appId] && !ready);

  const error = localErrors[selectedKey]
    ?? (selectedOption?.openState === 'failed' ? selectedOption.error : undefined)
    ?? (selected.kind === 'data' && !ready ? instanceErrors[selected.appId] : undefined)
    ?? null;

  const runOpen = useCallback(async (ref: SyncTargetRef, key: string) => {
    attemptedRef.current.add(key);
    setOpeningKeys(prev => ({ ...prev, [key]: true }));
    setLocalErrors(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      if (ref.kind === 'config') return;
      if (!ref.groupId) return;
      if (ref.appId === 'admin') {
        // admin 的数据组通常在启动时已激活；描述符后到的组按需补激活。
        if (!dataGroups.some(g => g.id === ref.groupId && g.group)) await refreshDataGroups();
        return;
      }
      const instance = getInstance(ref.appId);
      if (!instance) {
        await createInstance(ref.appId, ref.groupId);
        const after = getInstance(ref.appId);
        if (!after?.groups.some(g => g.id === ref.groupId && g.group && !g.error)) {
          await activateGroup(ref.appId, ref.groupId);
        }
      } else {
        await activateGroup(ref.appId, ref.groupId);
      }
    } catch (err) {
      setFailedKeys(prev => ({ ...prev, [key]: true }));
      setLocalErrors(prev => ({ ...prev, [key]: errorMessage(err) }));
    } finally {
      setOpeningKeys(prev => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }, [createInstance, activateGroup, getInstance, dataGroups, refreshDataGroups]);

  // 选中即后台打开；失败后停住，不自动回退 / 不自动重试。
  useEffect(() => {
    if (ready || opening) return;
    if (failedKeys[selectedKey]) return;
    if (attemptedRef.current.has(selectedKey)) return;
    attemptedRef.current.add(selectedKey);
    void runOpen(selected, selectedKey);
  }, [selectedKey, selected, ready, opening, failedKeys, runOpen]);

  const clearAttempt = useCallback((key: string) => {
    attemptedRef.current.delete(key);
    setFailedKeys(prev => {
      if (!(key in prev)) return prev;
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  }, []);

  const selectTarget = useCallback((key: string) => {
    const next = parseTargetKey(key);
    if (!next) return;
    const canonical = targetKey(next);
    clearAttempt(canonical);
    setSelectedKey(canonical);
    // 选择器切换后回到该组根部；其它页面保持当前路由，只更新查询参数。
    const base = location.pathname.startsWith('/files') ? '/files' : location.pathname;
    const params = new URLSearchParams(location.search);
    params.set('group', canonical);
    // 旧版本的命名空间参数已废弃，避免把过期参数带回地址栏。
    params.delete('ns');
    navigate(`${base}?${params.toString()}`, { replace: true });
  }, [location.pathname, location.search, navigate, clearAttempt]);

  const retry = useCallback(() => {
    clearAttempt(selectedKey);
    void runOpen(selected, selectedKey);
  }, [selectedKey, selected, runOpen, clearAttempt]);

  const switchToAdmin = useCallback(() => {
    selectTarget(DEFAULT_SYNC_TARGET_KEY);
  }, [selectTarget]);

  /**
   * 删除数据组登记：走 ConfigRepo 的正式删除路径（写墓碑），再 flush 把墓碑
   * 同步到远端，最后刷新总览（选择器里随之消失）。
   */
  const deleteDescriptor = useCallback(async (appId: string, groupId: string) => {
    if (!repo) throw new Error('配置仓尚未连接，无法删除描述符');
    await deleteDataGroupDescriptor(repo, appId, groupId);
    await repo.flush();
    await refreshDataGroups();
    const key = targetKey({ kind: 'data', appId, groupId });
    if (key === selectedKey) selectTarget(DEFAULT_SYNC_TARGET_KEY);
  }, [repo, refreshDataGroups, selectedKey, selectTarget]);

  const flushTarget = useCallback(async (): Promise<SyncResult[]> => {
    if (!handle) return [];
    const results = await handle.flush();
    return Array.isArray(results) ? results : [];
  }, [handle]);

  const getSyncStatuses = useCallback(
    () => (handle ? handle.getSyncStatuses() : new Map<string, SyncPairStatus>()),
    [handle],
  );
  const getBackendSyncStates = useCallback(
    () => (handle ? handle.getBackendSyncStates() : new Map<string, BackendSyncState>()),
    [handle],
  );
  const listDeclaredBackends = useCallback(
    () => (handle ? handle.listDeclaredBackends() : []),
    [handle],
  );

  const conflicts = useMemo<ConflictReader | null>(() => {
    if (!handle) return null;
    return {
      listConflicts: () => handle.listConflicts(),
      resolveConflict: (id, merged) => handle.resolveConflict(id, merged),
      readConflictBackup: (id, type) => handle.readConflictBackup(id, type),
    };
  }, [handle]);

  const configTargets = useMemo(() => targets.filter(t => t.ref.kind === 'config'), [targets]);
  const dataTargets = useMemo(() => targets.filter(t => t.ref.kind === 'data'), [targets]);

  return (
    <Context.Provider value={{
      targets,
      configTargets,
      dataTargets,
      selected,
      selectedKey,
      selectedOption,
      handle,
      fs,
      ready,
      opening,
      error,
      openedAppIds: instances.map(v => v.appId),
      maxInstances,
      selectTarget,
      retry,
      switchToAdmin,
      deleteDescriptor,
      flushTarget,
      getSyncStatuses,
      getBackendSyncStates,
      listDeclaredBackends,
      conflicts,
    }}>
      {children}
    </Context.Provider>
  );
}

export function useSyncTarget() {
  return useContext(Context);
}
