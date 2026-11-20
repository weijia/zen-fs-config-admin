import type {
  AppDataBackendDescriptor,
  BackendConflictInfo,
  BackendSyncState,
  SyncGroupHandle,
} from 'zen-fs-config';

/** 当前同步组的类型：配置同步组 / 数据同步组。 */
export type BackendScopeKind = 'config' | 'data';

/** 声明后端 + 运行时连接状态的一行展示数据。 */
export interface DeclaredBackendRow extends AppDataBackendDescriptor {
  connection: 'connected' | 'failed' | 'pending';
  errorMessage?: string;
  /**
   * 因「远端根属于另一个同步组」被跳过时的原因。
   *
   * 这类后端不会建同步对，`getBackendSyncStates()` 里既没有 pairId 也没有 error，
   * 只靠状态会显示成「未处理」——把库里的跳过原因透到 UI，用户才知道为什么没有数据。
   */
  skipReason?: string;
  /**
   * 结构化归属冲突：两侧 `kind` / `id` / `instanceId` 全量快照。
   * 老版本库只给 `listSkippedBackends()` 时为空，此时只能显示一句话原因。
   */
  conflict?: BackendConflictInfo;
}

/** 一侧身份的可读串（instanceId 给全值，便于跨环境核对）。 */
export function formatConflictSide(
  side: { kind?: string; id?: string; instanceId?: string } | null | undefined,
): string {
  if (!side) return '（读不到远端 group.json）';
  return `kind=${side.kind ?? '（无）'} · id=${side.id ?? '（无）'} · 实例 ID=${side.instanceId ?? '（无）'}`;
}

/** 当前作用域是否提供编辑能力（配置组与数据组都可写，写的是各自的后端定义）。 */
export interface ScopeCapabilities {
  canAdd: boolean;
  canEdit: boolean;
  canRemove: boolean;
  canToggle: boolean;
}

export interface BackendScopeView {
  kind: BackendScopeKind;
  title: string;
  subtitle: string;
  /** 该作用域使用哪份后端文件作为数据源。 */
  sourceNote: string;
  readOnly: boolean;
}

type DeclaredBackendHandle = Pick<
  SyncGroupHandle,
  'listDeclaredBackends' | 'getBackendSyncStates'
> & Partial<Pick<SyncGroupHandle, 'listSkippedBackends' | 'listBackendConflicts'>>;

/**
 * 把后端同步状态归一成三态：
 * - 有 error → failed（保留原始错误文案）
 * - 有 pairId → connected
 * - 两者都没有 → pending（从未处理）
 */
export function describeBackendConnection(
  state?: BackendSyncState,
): Pick<DeclaredBackendRow, 'connection' | 'errorMessage'> {
  if (state?.error) {
    return { connection: 'failed', errorMessage: state.error.message };
  }
  if (state?.pairId) {
    return { connection: 'connected' };
  }
  return { connection: 'pending' };
}

/** 连接状态的展示文案；失败/跳过时带上完整原因原文。 */
export function backendConnectionText(
  row: Pick<DeclaredBackendRow, 'connection' | 'errorMessage' | 'skipReason'>,
): string {
  if (row.skipReason) return `已跳过：${row.skipReason}`;
  switch (row.connection) {
    case 'connected':
      return '已连接';
    case 'failed':
      return row.errorMessage ? `失败：${row.errorMessage}` : '失败';
    default:
      return '未处理';
  }
}

/**
 * 读取当前组句柄的声明后端并合并连接状态。
 * 只做投影，不注入 local-idb，也不读取其他作用域的后端。
 */
export function collectDeclaredBackends(
  handle: DeclaredBackendHandle | null,
): DeclaredBackendRow[] {
  if (!handle) return [];
  const states = handle.getBackendSyncStates();
  const skipped = new Map(
    (handle.listSkippedBackends?.() ?? []).map(s => [s.backendId, s.reason] as const),
  );
  const conflicts = new Map(
    (handle.listBackendConflicts?.() ?? []).map(c => [c.backendId, c] as const),
  );
  return handle.listDeclaredBackends().map((backend) => {
    const conflict = conflicts.get(backend.id);
    const skipReason = skipped.get(backend.id) ?? conflict?.reason;
    return {
      ...backend,
      ...describeBackendConnection(states.get(backend.id)),
      ...(skipReason ? { skipReason } : {}),
      ...(conflict ? { conflict } : {}),
    };
  });
}

/** 数据组后端列表的来源。 */
export type ScopedBackendSource = 'data-group' | 'bootstrap' | 'none';

/** 数据组作用域的后端视图。 */
export interface ScopedBackendView {
  source: ScopedBackendSource;
  /** 权威声明行（仅 `source === 'data-group'` 时有值）。 */
  rows: DeclaredBackendRow[];
  /** 引导副本里的后端（仅 `source === 'bootstrap'` 时有值）。 */
  bootstrap: Array<{ id: string; type: string }>;
}

/**
 * 决定数据组后端列表的来源。
 *
 * 规则（与「权威不变、不做并集」一致）：
 *   · 组已激活（有句柄）→ 只读组内 `.meta/backends/`，引导副本不参与；
 *   · 组未激活且副本有记录 → 副本作为引导视图，UI 必须标注「尚未激活」；
 *   · 其余 → 空。
 *
 * 副本里有、权威里没有的后端 id 不会出现在 `rows` 里（反之亦然），
 * 避免已删除的后端因副本滞后而「复活」。
 */
export function resolveScopedBackends(
  handle: DeclaredBackendHandle | null,
  entry?: { bootstrapBackends: Array<{ id: string; type: string }> } | null,
): ScopedBackendView {
  if (handle) {
    return { source: 'data-group', rows: collectDeclaredBackends(handle), bootstrap: [] };
  }
  const bootstrap = entry?.bootstrapBackends ?? [];
  if (bootstrap.length > 0) {
    return { source: 'bootstrap', rows: [], bootstrap: [...bootstrap] };
  }
  return { source: 'none', rows: [], bootstrap: [] };
}

/**
 * 两个作用域都提供写能力：写的是各自组 `.meta/backends/` 的权威定义。
 * 数据组没有 enabled/disabled 开关（启用即建同步对，删除即断），所以 canToggle 为 false。
 */
export function scopeCapabilities(kind: BackendScopeKind): ScopeCapabilities {
  if (kind === 'data') {
    return { canAdd: true, canEdit: true, canRemove: true, canToggle: false };
  }
  return { canAdd: true, canEdit: true, canRemove: true, canToggle: true };
}

/** 页面标题/说明用的作用域描述。 */
export function describeBackendScope(ref: {
  kind: BackendScopeKind;
  appId: string;
  groupId: string | null;
}): BackendScopeView {
  if (ref.kind === 'data') {
    return {
      kind: 'data',
      title: `数据组 ${ref.appId} / ${ref.groupId}`,
      subtitle: '该数据组自己的同步后端',
      sourceNote:
        '数据源：组内 .meta/backends/（权威声明），不是配置组描述符里的引导副本。增删改直接写这份权威定义并重建同步对。',
      readOnly: false,
    };
  }
  return {
    kind: 'config',
    title: '配置同步组（admin）',
    subtitle: '仓库级同步后端',
    sourceNote:
      '数据源：配置仓 .config/backends/；getBackends() 额外包含隐式 local-idb 主存储。编辑入口在本栏。',
    readOnly: false,
  };
}
