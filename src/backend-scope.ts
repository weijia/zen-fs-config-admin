import type { AppDataBackendDescriptor, BackendSyncState, SyncGroupHandle } from 'zen-fs-config';

/** 当前同步组的类型：配置同步组 / 数据同步组。 */
export type BackendScopeKind = 'config' | 'data';

/** 声明后端 + 运行时连接状态的一行展示数据。 */
export interface DeclaredBackendRow extends AppDataBackendDescriptor {
  connection: 'connected' | 'failed' | 'pending';
  errorMessage?: string;
}

/** 当前作用域是否提供编辑能力（本版只有配置组可写，数据组只读）。 */
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
>;

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

/** 连接状态的展示文案；失败时带上完整原文。 */
export function backendConnectionText(
  row: Pick<DeclaredBackendRow, 'connection' | 'errorMessage'>,
): string {
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
  return handle.listDeclaredBackends().map((backend) => ({
    ...backend,
    ...describeBackendConnection(states.get(backend.id)),
  }));
}

/**
 * 本版的上半栏只读；编辑能力只属于配置同步组（合并进下半栏）。
 * 组件用这份能力表来决定是否渲染写控件。
 */
export function scopeCapabilities(kind: BackendScopeKind): ScopeCapabilities {
  if (kind === 'data') {
    return { canAdd: false, canEdit: false, canRemove: false, canToggle: false };
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
      subtitle: '该数据组自己的同步后端（只读）',
      sourceNote:
        '数据源：组内 .meta/backends/（权威声明），不是配置组描述符里的引导副本。编辑入口在 Data Groups 页。',
      readOnly: true,
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
