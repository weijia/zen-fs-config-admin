/**
 * 多实例（懒创建）的 React 绑定。
 *
 * 纯逻辑在 `../repo-instances.ts`；这里只负责：
 *   · 把 admin repo 的远端后端信息传给注册表（新实例连接同一远端）；
 *   · 为每个 appId 生成独立的 nodeId（localStorage），避免 author 冲突；
 *   · 维护创建中 / 错误 / 版本号状态，驱动 Files 页重渲染。
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { createConfigRepo } from 'zen-fs-config';
import { useConfigRepo } from './ConfigRepoContext';
import '../register-backends';
import {
  RepoInstanceRegistry,
  DEFAULT_MAX_INSTANCES,
  type RepoInstance,
  type RepoInstanceStatus,
} from '../repo-instances';

const NODE_ID_STORAGE_KEY = 'zen-fs-config-admin:node-id';
const CACHE_TTL_MS = 300000;

function getOrCreateNodeId(appId: string): string {
  const key = `${NODE_ID_STORAGE_KEY}:${appId}`;
  try {
    let nodeId = localStorage.getItem(key);
    if (!nodeId) {
      nodeId = `node-${appId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(key, nodeId);
    }
    return nodeId;
  } catch {
    return `node-${appId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export interface RepoInstanceView {
  appId: string;
  backendId: string;
  groups: RepoInstance['groups'];
  status: RepoInstanceStatus;
}

interface RepoInstancesContextValue {
  /** 已创建的实例快照（按 appId 排序）。 */
  instances: RepoInstanceView[];
  /** appId → 最近一次失败原因（创建 / 释放 / 组操作）。 */
  errors: Record<string, string>;
  /** appId → 是否正在创建。 */
  creating: Record<string, boolean>;
  /** 版本号：实例 / 组发生变化时递增，供文件树刷新总览。 */
  revision: number;
  /** 并发上限（用于 UI 提示）。 */
  maxInstances: number;
  /** 懒创建实例；失败时抛出并记录到 errors。 */
  createInstance: (appId: string, onlyGroupId?: string | null) => Promise<RepoInstance>;
  /** 在已创建的实例上激活单个组。 */
  activateGroup: (appId: string, groupId: string) => Promise<void>;
  /** 重新读取实例已激活组的状态（不激活新组）。 */
  refreshInstance: (appId: string) => Promise<void>;
  /** 释放实例：flush → dispose → 移除。 */
  releaseInstance: (appId: string) => Promise<void>;
  /** 取实例（未创建时 undefined）。 */
  getInstance: (appId: string) => RepoInstance | undefined;
  /** 状态快照（未创建时 null）。 */
  getStatus: (appId: string) => RepoInstanceStatus | null;
  renameGroup: (appId: string, groupId: string, name: string) => Promise<void>;
  replaceBackend: (
    appId: string,
    groupId: string,
    backendId: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ) => Promise<void>;
  addBackend: (
    appId: string,
    groupId: string,
    backendId: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ) => Promise<void>;
  removeBackend: (appId: string, groupId: string, backendId: string) => Promise<void>;
  removeGroup: (appId: string, groupId: string) => Promise<void>;
  flushInstance: (appId: string) => Promise<void>;
}

const Context = createContext<RepoInstancesContextValue>({
  instances: [],
  errors: {},
  creating: {},
  revision: 0,
  maxInstances: DEFAULT_MAX_INSTANCES,
  createInstance: async () => { throw new Error('RepoInstancesProvider not mounted'); },
  activateGroup: async () => {},
  refreshInstance: async () => {},
  releaseInstance: async () => {},
  getInstance: () => undefined,
  getStatus: () => null,
  renameGroup: async () => {},
  replaceBackend: async () => {},
  addBackend: async () => {},
  removeBackend: async () => {},
  removeGroup: async () => {},
  flushInstance: async () => {},
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function RepoInstancesProvider({ children }: { children: ReactNode }) {
  const { repo } = useConfigRepo();

  /**
   * 始终指向最新的 admin repo（reconnect 后仍能取到远端后端信息）。
   * 这里在渲染期同步赋值：子 Provider 的 effect 先于父组件的 effect 执行，
   * 若放到 useEffect 里，自动打开会读到上一轮的 null 而误判为「未就绪」。
   */
  const adminRepoRef = useRef(repo);
  adminRepoRef.current = repo;

  const registryRef = useRef<RepoInstanceRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new RepoInstanceRegistry({
      createRepo: async (appId, backend) => createConfigRepo(appId, {
        nodeId: getOrCreateNodeId(appId),
        cache: { storeType: 'IdbCacheStore', ttlMs: CACHE_TTL_MS },
        // 复用 admin 已配置的远端后端 id / 参数，不额外写入新的后端描述符。
        backendInfo: { type: backend.type, options: backend.options },
        primaryBackendId: backend.id,
      }),
      getRemoteBackend: async () => {
        const adminRepo = adminRepoRef.current;
        // 冷启动 / Reconnect 期间 admin 配置仓还没就绪：这是暂时状态，不应误报成「没有后端」。
        if (!adminRepo) return { status: 'not-ready' };
        const meta = await adminRepo.getBackends();
        // `getBackends()` 的首项是隐式的本地 IndexedDB 主存储；实例需要的是远端副本。
        const replica = (meta?.backends ?? []).find(b => b.id !== 'local-idb');
        if (!replica) return { status: 'none' };
        return { status: 'ok', backend: { id: replica.id, type: replica.type, options: replica.options } };
      },
    });
  }
  const registry = registryRef.current;

  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const bump = useCallback(() => setRevision(v => v + 1), []);
  const clearError = useCallback((appId: string) => {
    setErrors(prev => {
      if (!(appId in prev)) return prev;
      const next = { ...prev };
      delete next[appId];
      return next;
    });
  }, []);
  const recordError = useCallback((appId: string, message: string) => {
    setErrors(prev => ({ ...prev, [appId]: message }));
  }, []);

  const createInstance = useCallback(async (appId: string, onlyGroupId?: string | null) => {
    setCreating(prev => ({ ...prev, [appId]: true }));
    clearError(appId);
    try {
      const instance = await registry.create(appId, onlyGroupId);
      return instance;
    } catch (err) {
      recordError(appId, errorMessage(err));
      throw err;
    } finally {
      setCreating(prev => {
        const next = { ...prev };
        delete next[appId];
        return next;
      });
      bump();
    }
  }, [registry, bump, clearError, recordError]);

  const releaseInstance = useCallback(async (appId: string) => {
    clearError(appId);
    try {
      await registry.release(appId);
    } catch (err) {
      recordError(appId, errorMessage(err));
      throw err;
    } finally {
      bump();
    }
  }, [registry, bump, clearError, recordError]);

  const getInstance = useCallback((appId: string) => registry.get(appId), [registry]);
  const getStatus = useCallback((appId: string) => registry.status(appId), [registry]);

  /** 组操作统一包装：失败记录到该 appId，成功后 bump。 */
  const runGroupOp = useCallback(async (appId: string, op: () => Promise<void>) => {
    clearError(appId);
    try {
      await op();
    } catch (err) {
      recordError(appId, errorMessage(err));
      throw err;
    } finally {
      bump();
    }
  }, [bump, clearError, recordError]);

  const renameGroup = useCallback((appId: string, groupId: string, name: string) =>
    runGroupOp(appId, () => registry.renameGroup(appId, groupId, name)), [registry, runGroupOp]);

  const replaceBackend = useCallback((
    appId: string,
    groupId: string,
    backendId: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ) => runGroupOp(appId, () =>
    registry.replaceBackend(appId, groupId, backendId, type, options, description)), [registry, runGroupOp]);

  const addBackend = useCallback((
    appId: string,
    groupId: string,
    backendId: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ) => runGroupOp(appId, () =>
    registry.addBackend(appId, groupId, backendId, type, options, description)), [registry, runGroupOp]);

  const removeBackend = useCallback((appId: string, groupId: string, backendId: string) =>
    runGroupOp(appId, () => registry.removeBackend(appId, groupId, backendId)), [registry, runGroupOp]);

  const removeGroup = useCallback((appId: string, groupId: string) =>
    runGroupOp(appId, () => registry.removeGroup(appId, groupId)), [registry, runGroupOp]);

  const activateGroup = useCallback((appId: string, groupId: string) =>
    runGroupOp(appId, async () => { await registry.activateGroup(appId, groupId); }), [registry, runGroupOp]);

  const refreshInstance = useCallback((appId: string) =>
    runGroupOp(appId, () => registry.refresh(appId)), [registry, runGroupOp]);

  const flushInstance = useCallback((appId: string) =>
    runGroupOp(appId, () => registry.flush(appId)), [registry, runGroupOp]);

  const instances = useMemo<RepoInstanceView[]>(() => {
    void revision; // 依赖版本号，registry 为可变对象
    return registry.list()
      .map(instance => {
        const status = registry.status(instance.appId);
        return status
          ? { appId: instance.appId, backendId: instance.backendId, groups: instance.groups, status }
          : null;
      })
      .filter((v): v is RepoInstanceView => v !== null)
      .sort((a, b) => a.appId.localeCompare(b.appId));
  }, [registry, revision]);

  useEffect(() => () => {
    // 组件卸载（例如页面关闭 / 热更新）时尽力 flush 并断开，避免丢数据。
    void registry.disposeAll();
  }, [registry]);

  return (
    <Context.Provider value={{
      instances,
      errors,
      creating,
      revision,
      maxInstances: DEFAULT_MAX_INSTANCES,
      createInstance,
      activateGroup,
      refreshInstance,
      releaseInstance,
      getInstance,
      getStatus,
      renameGroup,
      replaceBackend,
      addBackend,
      removeBackend,
      removeGroup,
      flushInstance,
    }}>
      {children}
    </Context.Provider>
  );
}

export function useRepoInstances() {
  return useContext(Context);
}
