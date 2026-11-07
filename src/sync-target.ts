/**
 * 「同步组 target」模型。
 *
 * 顶栏选择器、Files / Conflicts / 同步状态的页面跟随都围绕一个 target：
 *   · `config:<appId>`      → 某个 appId 的配置同步组（admin 常驻，其它 appId 需懒创建实例）
 *   · `data:<appId>:<gid>`  → 某个 appId 下的数据同步组（描述符存在即可被选中）
 *
 * 枚举来源刻意不依赖运行态：数据组来自 `.config` / `.meta` 描述符总览，
 * 配置组来自 admin 自身 + 描述符里出现的 appId + 已注册实例，因此「尚未打开」
 * 的组也会出现在列表里。
 *
 * 纯函数，供 context 与测试复用。
 */
import type { DataGroupOverview } from './data-group-overview';

export type SyncTargetKind = 'config' | 'data';

export interface SyncTargetRef {
  kind: SyncTargetKind;
  appId: string;
  /** 数据组为目标时是组 id；配置组为 null。 */
  groupId: string | null;
}

/** 默认 target：admin 的配置同步组。 */
export const DEFAULT_SYNC_TARGET: SyncTargetRef = { kind: 'config', appId: 'admin', groupId: null };
export const DEFAULT_SYNC_TARGET_KEY = targetKey(DEFAULT_SYNC_TARGET);

/** 目标地址（写进 `?group=` / localStorage）。 */
export function targetKey(ref: SyncTargetRef): string {
  return ref.kind === 'config'
    ? `config:${ref.appId}`
    : `data:${ref.appId}:${ref.groupId ?? ''}`;
}

/** 解析目标地址；格式非法时返回 null。 */
export function parseTargetKey(key: string | null | undefined): SyncTargetRef | null {
  if (!key) return null;
  const parts = key.split(':');
  if (parts[0] === 'config' && parts.length === 2 && parts[1]) {
    return { kind: 'config', appId: parts[1], groupId: null };
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
  /** 配置组自身的同步对数量。 */
  pairCount: number;
  watchingCount: number;
  groups: SyncTargetGroupSnapshot[];
}

export type TargetOpenState = 'open' | 'opening' | 'closed' | 'failed';
export type TargetSyncHealth = 'ok' | 'syncing' | 'error' | 'unknown';

export interface SyncTargetOption {
  ref: SyncTargetRef;
  key: string;
  label: string;
  openState: TargetOpenState;
  health: TargetSyncHealth;
  /** 行内状态说明（「已打开 · 2 对」/「首次选择将建立实例并同步」）。 */
  detail: string;
  /** 描述符声明的后端数（未打开时的只读信息）。 */
  backendsCount: number;
  backendsSource: 'data-group' | 'bootstrap' | 'config';
  /** 打开失败的真实原因。 */
  error?: string;
}

const OPEN_HINT = '首次选择将建立实例并同步';

function healthOf(open: boolean, watching: number, error: string | undefined): TargetSyncHealth {
  if (error) return 'error';
  if (!open) return 'unknown';
  return watching > 0 ? 'syncing' : 'ok';
}

function configOption(
  appId: string,
  snapshot: SyncTargetInstanceSnapshot | undefined,
  fallback: { backendsCount: number; error?: string } | undefined,
): SyncTargetOption {
  const open = !!snapshot?.open;
  const creating = !!snapshot?.creating;
  const error = snapshot?.error ?? fallback?.error;
  const openState: TargetOpenState = open
    ? 'open'
    : creating ? 'opening' : error ? 'failed' : 'closed';
  const detail = open
    ? `已打开 · ${snapshot?.pairCount ?? 0} 对${snapshot?.watchingCount ? ' · 同步中' : ''}`
    : creating ? '正在打开…（首次同步可能需要几十秒）' : error ? `打开失败：${error}` : OPEN_HINT;

  return {
    ref: { kind: 'config', appId, groupId: null },
    key: targetKey({ kind: 'config', appId, groupId: null }),
    label: `${appId} 配置组`,
    openState,
    health: healthOf(open, snapshot?.watchingCount ?? 0, error),
    detail,
    backendsCount: fallback?.backendsCount ?? 0,
    backendsSource: 'config',
    error,
  };
}

function dataOption(
  ref: SyncTargetRef,
  descriptor: DataGroupOverview['apps'][number]['entries'][number] | null,
  snapshot: SyncTargetGroupSnapshot | undefined,
  instance: SyncTargetInstanceSnapshot | undefined,
): SyncTargetOption {
  const error = snapshot?.error ?? instance?.error;
  const open = !!snapshot?.activated;
  const creating = !!instance?.creating;
  const openState: TargetOpenState = open
    ? 'open'
    : creating ? 'opening' : error ? 'failed' : 'closed';
  const label = snapshot?.name ?? descriptor?.name ?? ref.groupId ?? '';
  const backendsCount = snapshot?.backendsCount ?? descriptor?.backendsCount ?? 0;
  const detail = open
    ? `已打开 · ${snapshot?.pairCount ?? 0} 对${snapshot?.watchingCount ? ' · 同步中' : ''}`
    : creating ? '正在打开…（首次同步可能需要几十秒）' : error ? `打开失败：${error}` : OPEN_HINT;

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

/**
 * 汇总可选 target。
 *
 * @param overview 跨 appId 数据组描述符总览（只读，来源为 .config/.meta）。
 * @param instances 每个 appId 的运行态快照（admin 也在内）。
 */
export function collectSyncTargets(
  overview: DataGroupOverview,
  instances: SyncTargetInstanceSnapshot[],
): SyncTargetOption[] {
  const byApp = new Map(instances.map(s => [s.appId, s]));
  const configs: SyncTargetOption[] = [];

  const appIds = new Set<string>(['admin', ...overview.apps.map(a => a.appId), ...instances.map(i => i.appId)]);
  for (const appId of appIds) {
    configs.push(configOption(appId, byApp.get(appId), undefined));
  }
  configs.sort((a, b) => {
    if (a.ref.appId === 'admin') return -1;
    if (b.ref.appId === 'admin') return 1;
    return a.ref.appId.localeCompare(b.ref.appId);
  });

  const dataByKey = new Map<string, SyncTargetOption>();
  const descriptors = new Map<string, DataGroupOverview['apps'][number]['entries'][number]>();
  for (const app of overview.apps) {
    for (const entry of app.entries) {
      if (!entry.parsed || !entry.isDataSync) continue;
      descriptors.set(`${app.appId}/${entry.id}`, entry);
    }
  }
  for (const app of overview.apps) {
    for (const entry of app.entries) {
      if (!entry.parsed || !entry.isDataSync) continue;
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
