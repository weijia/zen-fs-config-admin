/**
 * 「同步组 target」模型。
 *
 * 只有两层，都是组：
 *   · 配置同步组（唯一）：admin 连接的那个远端配置仓本身，地址 `config`，
 *     Files 根是 admin 自己的分区 `/{admin}`（写入走 ConfigRepo 的墓碑钩子）；
 *   · 数据同步组：`data:<appId>:<gid>`，描述符登记在配置仓内、彼此独立，
 *     可单独打开 / 改文件 / 看同步健康。
 *
 * appId 只是配置仓内部的实现细节（同一份仓被多个应用共用、各写自己的分区），
 * 不是用户可选的组，只在数据组行里作为次要信息展示。
 *
 * 兼容：旧地址 `config:<appId>` 一律归一为 `config`（appId 不再参与选择）。
 * `?ns=` 等旧参数被忽略。
 *
 * 枚举来源刻意不依赖运行态：数据组来自 `.config` / `.meta` 描述符总览。
 * 解析失败的描述符也会入列（标记为不可打开），不再静默跳过。
 *
 * 纯函数，供 context 与测试复用。
 */
import type { DataGroupOverview, DataGroupOverviewEntry } from './data-group-overview';

export type SyncTargetKind = 'config' | 'data';

export interface SyncTargetRef {
  kind: SyncTargetKind;
  /** 数据组所属的 appId（仅作次要信息）；配置组恒为 `admin`。 */
  appId: string;
  /** 数据组为目标时是组 id；配置组为 null。 */
  groupId: string | null;
}

/** 默认 target：唯一的配置同步组。 */
export const DEFAULT_SYNC_TARGET: SyncTargetRef = { kind: 'config', appId: 'admin', groupId: null };
export const DEFAULT_SYNC_TARGET_KEY = targetKey(DEFAULT_SYNC_TARGET);

/** 目标地址（写进 `?group=` / localStorage）。 */
export function targetKey(ref: SyncTargetRef): string {
  return ref.kind === 'config'
    ? 'config'
    : `data:${ref.appId}:${ref.groupId ?? ''}`;
}

/** 解析目标地址；格式非法时返回 null。兼容旧地址 `config:<appId>`。 */
export function parseTargetKey(key: string | null | undefined): SyncTargetRef | null {
  if (!key) return null;
  if (key === 'config') return { kind: 'config', appId: 'admin', groupId: null };
  const parts = key.split(':');
  if (parts[0] === 'config' && parts.length === 2) {
    // 旧格式：当年按 appId 拆出来的「配置组」，现在统一归一到唯一的配置组。
    return { kind: 'config', appId: 'admin', groupId: null };
  }
  if (parts[0] === 'data' && parts.length === 3 && parts[1] && parts[2]) {
    return { kind: 'data', appId: parts[1], groupId: parts[2] };
  }
  return null;
}

/** 两个 target 是否相同。 */
export function sameTarget(a: SyncTargetRef | null, b: SyncTargetRef | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.appId === b.appId && a.groupId === b.groupId;
}

/** 单个组的运行态快照。 */
export interface SyncTargetGroupSnapshot {
  appId: string;
  groupId: string;
  name?: string;
  backendsCount: number;
  pairCount: number;
  watchingCount: number;
  /** 组句柄是否已激活（能浏览文件 / 读同步状态）。 */
  activated: boolean;
  error?: string;
}

/** 单个 appId 实例的运行态快照（含 admin）。 */
export interface SyncTargetInstanceSnapshot {
  appId: string;
  open: boolean;
  creating: boolean;
  error?: string;
  /** 配置本身声明的后端数量。 */
  backendsCount: number;
  /** 配置组自身的同步对数量。 */
  pairCount: number;
  watchingCount: number;
  groups: SyncTargetGroupSnapshot[];
}

export type TargetOpenState = 'open' | 'opening' | 'closed' | 'failed' | 'invalid';
export type TargetSyncHealth = 'ok' | 'syncing' | 'error' | 'unknown';

export interface SyncTargetOption {
  ref: SyncTargetRef;
  key: string;
  label: string;
  openState: TargetOpenState;
  health: TargetSyncHealth;
  /** 行内状态说明（「已打开 · 2 个后端 · 2 对」/「首次选择将建立实例并同步」）。 */
  detail: string;
  /** 声明的后端数量（未打开时也能显示）。 */
  backendsCount: number;
  backendsSource: 'data-group' | 'bootstrap' | 'config';
  /** 打开失败 / 描述符解析失败的真实原因。 */
  error?: string;
}

const OPEN_HINT = '首次选择将建立实例并同步';

function healthOf(open: boolean, watching: number, error: string | undefined): TargetSyncHealth {
  if (error) return 'error';
  if (!open) return 'unknown';
  return watching > 0 ? 'syncing' : 'ok';
}

function openStateOf(
  open: boolean,
  creating: boolean,
  error: string | undefined,
): TargetOpenState {
  return open ? 'open' : creating ? 'opening' : error ? 'failed' : 'closed';
}

/** 唯一的配置同步组（admin 连接的那个远端）。 */
function configOption(snapshot: SyncTargetInstanceSnapshot | undefined): SyncTargetOption {
  const open = !!snapshot?.open;
  const creating = !!snapshot?.creating;
  const error = snapshot?.error;
  const openState = openStateOf(open, creating, error);
  const backendsCount = snapshot?.backendsCount ?? 0;
  const detail = open
    ? `已打开 · ${backendsCount} 个后端 · ${snapshot?.pairCount ?? 0} 对${snapshot?.watchingCount ? ' · 同步中' : ''}`
    : creating ? '正在打开…（首次同步可能需要几十秒）' : error ? `打开失败：${error}` : OPEN_HINT;

  return {
    ref: { kind: 'config', appId: 'admin', groupId: null },
    key: DEFAULT_SYNC_TARGET_KEY,
    label: '配置同步组',
    openState,
    health: healthOf(open, snapshot?.watchingCount ?? 0, error),
    detail,
    backendsCount,
    backendsSource: 'config',
    error,
  };
}

function dataOption(
  ref: SyncTargetRef,
  descriptor: DataGroupOverviewEntry | null,
  snapshot: SyncTargetGroupSnapshot | undefined,
  instance: SyncTargetInstanceSnapshot | undefined,
): SyncTargetOption {
  const invalid = !!descriptor && !descriptor.parsed && !!descriptor.problem;
  const error = invalid ? (descriptor.problem ?? '描述符解析失败') : (snapshot?.error ?? instance?.error);
  const open = !!snapshot?.activated;
  const creating = !!instance?.creating;
  const openState: TargetOpenState = invalid
    ? 'invalid'
    : openStateOf(open, creating, error);
  const label = snapshot?.name ?? descriptor?.name ?? ref.groupId ?? '';
  const backendsCount = snapshot?.backendsCount ?? descriptor?.backendsCount ?? 0;
  const detail = invalid
    ? `描述符解析失败：${descriptor.problem}`
    : open
      ? `已打开 · ${backendsCount} 个后端 · ${snapshot?.pairCount ?? 0} 对${snapshot?.watchingCount ? ' · 同步中' : ''}`
      : creating
        ? '正在打开…（首次同步可能需要几十秒）'
        : error
          ? `打开失败：${error}`
          : `${backendsCount} 个后端 · ${OPEN_HINT}`;

  return {
    ref,
    key: targetKey(ref),
    label,
    openState,
    health: healthOf(open, snapshot?.watchingCount ?? 0, error),
    detail,
    backendsCount,
    backendsSource: snapshot ? 'data-group' : (descriptor?.backendsSource ?? 'bootstrap'),
    error,
  };
}

/** 描述符是否应进入数据组列表（解析失败的也保留，标记不可打开）。 */
function isListableDescriptor(entry: DataGroupOverviewEntry): boolean {
  if (!entry.parsed) return !!entry.problem;
  return entry.isDataSync;
}

/**
 * 汇总可选 target：唯一配置组 + 平铺的数据组（含解析失败的描述符）。
 *
 * @param overview 跨 appId 数据组描述符总览（只读，来源为 .config/.meta）。
 * @param instances 每个 appId 的运行态快照（admin 也在内）。
 */
export function collectSyncTargets(
  overview: DataGroupOverview,
  instances: SyncTargetInstanceSnapshot[],
): SyncTargetOption[] {
  const byApp = new Map(instances.map(s => [s.appId, s]));
  const configs: SyncTargetOption[] = [configOption(byApp.get('admin'))];

  const dataByKey = new Map<string, SyncTargetOption>();
  const descriptors = new Map<string, DataGroupOverviewEntry>();
  for (const app of overview.apps) {
    for (const entry of app.entries) {
      if (!isListableDescriptor(entry)) continue;
      descriptors.set(`${app.appId}/${entry.id}`, entry);
    }
  }
  for (const app of overview.apps) {
    for (const entry of app.entries) {
      if (!isListableDescriptor(entry)) continue;
      const ref: SyncTargetRef = { kind: 'data', appId: app.appId, groupId: entry.id };
      const key = targetKey(ref);
      const instance = byApp.get(app.appId);
      const snapshot = instance?.groups.find(g => g.groupId === entry.id);
      dataByKey.set(key, dataOption(ref, entry, snapshot, instance));
    }
  }
  // 已激活 / 激活失败的组一定有句柄，即使描述符没被总览扫到（legacy / 尚未刷新）。
  for (const instance of instances) {
    for (const group of instance.groups) {
      const ref: SyncTargetRef = { kind: 'data', appId: instance.appId, groupId: group.groupId };
      const key = targetKey(ref);
      const descriptor = descriptors.get(`${instance.appId}/${group.groupId}`) ?? null;
      const existing = dataByKey.get(key);
      if (existing && existing.openState === 'open') continue;
      dataByKey.set(key, dataOption(ref, descriptor, group, instance));
    }
  }

  const data = Array.from(dataByKey.values()).sort((a, b) => {
    if (a.ref.appId !== b.ref.appId) return a.ref.appId.localeCompare(b.ref.appId);
    return a.label.localeCompare(b.label) || (a.ref.groupId ?? '').localeCompare(b.ref.groupId ?? '');
  });

  return [...configs, ...data];
}

/** 目标在 Files 树里的路径前缀（配置组为 `''`）。 */
export function targetPathPrefix(ref: SyncTargetRef): string {
  if (ref.kind === 'config') return '';
  const base = ref.appId === 'admin'
    ? `/@dg/${ref.groupId}`
    : `/@adg/${ref.appId}/${ref.groupId}`;
  return base;
}

/** 描述里用的短标签（`kind` 徽标）。 */
export function targetKindLabel(ref: SyncTargetRef): string {
  return ref.kind === 'config' ? 'config-sync' : 'data-sync';
}
