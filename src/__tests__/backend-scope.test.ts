import { describe, it, expect } from 'vitest';
import type { AppDataBackendDescriptor, BackendSyncState } from 'zen-fs-config';
import {
  backendConnectionText,
  collectDeclaredBackends,
  describeBackendConnection,
  describeBackendScope,
  resolveScopedBackends,
  scopeCapabilities,
} from '../backend-scope';

function backend(id: string, type = 'Gitee'): AppDataBackendDescriptor {
  return { id, type, options: {} };
}

function handle(
  declared: AppDataBackendDescriptor[],
  states: Map<string, BackendSyncState>,
) {
  return {
    listDeclaredBackends: () => declared,
    getBackendSyncStates: () => states,
  };
}

describe('backend-scope', () => {
  it('配置组取数只来自声明列表，不注入 local-idb', () => {
    const h = handle(
      [backend('gitee-1'), backend('rs-1', 'RemoteStorage')],
      new Map<string, BackendSyncState>(),
    );
    const rows = collectDeclaredBackends(h);
    expect(rows.map(r => r.id)).toEqual(['gitee-1', 'rs-1']);
    expect(rows.some(r => r.id === 'local-idb')).toBe(false);
  });

  it('数据组把 pairId / error / 无状态映射成三种连接状态，并保留失败原文', () => {
    const h = handle(
      [backend('connected-backend'), backend('failed-backend'), backend('pending-backend')],
      new Map<string, BackendSyncState>([
        ['connected-backend', { backendId: 'connected-backend', pairId: 'pair-1' }],
        [
          'failed-backend',
          { backendId: 'failed-backend', error: { message: '401 Unauthorized', timestamp: 1 } },
        ],
      ]),
    );
    const rows = collectDeclaredBackends(h);

    expect(rows[0]).toMatchObject({ id: 'connected-backend', connection: 'connected' });
    expect(rows[1]).toMatchObject({
      id: 'failed-backend',
      connection: 'failed',
      errorMessage: '401 Unauthorized',
    });
    expect(rows[2]).toMatchObject({ id: 'pending-backend', connection: 'pending' });
  });

  it('失败状态文案包含库返回的完整错误原文', () => {
    expect(backendConnectionText(describeBackendConnection({ backendId: 'x', pairId: 'p' })))
      .toBe('已连接');
    expect(backendConnectionText(describeBackendConnection(undefined))).toBe('未处理');
    expect(
      backendConnectionText(
        describeBackendConnection({
          backendId: 'x',
          error: { message: 'Gitee API 400: 文件新建失败', timestamp: 1 },
        }),
      ),
    ).toBe('失败：Gitee API 400: 文件新建失败');
  });

  it('数据组作用域标注 .meta/backends 权威来源且只读', () => {
    const scope = describeBackendScope({ kind: 'data', appId: 'weijia432', groupId: 'dir-struct-gen' });
    expect(scope.title).toContain('weijia432');
    expect(scope.title).toContain('dir-struct-gen');
    expect(scope.readOnly).toBe(true);
    expect(scope.sourceNote).toContain('.meta/backends/');
    expect(scope.sourceNote).toContain('引导副本');
    expect(scope.sourceNote).toContain('Data Groups');
  });

  it('配置组作用域标注 .config/backends 来源且可编辑', () => {
    const scope = describeBackendScope({ kind: 'config', appId: 'admin', groupId: 'config' });
    expect(scope.title).toContain('配置同步组（admin）');
    expect(scope.readOnly).toBe(false);
    expect(scope.sourceNote).toContain('.config/backends/');
    expect(scope.sourceNote).toContain('local-idb');
  });

  it('数据组不提供任何写能力，页面的写控件因此不会渲染', () => {
    expect(scopeCapabilities('data')).toEqual({
      canAdd: false,
      canEdit: false,
      canRemove: false,
      canToggle: false,
    });
  });

  it('配置组保留下半栏的写能力', () => {
    expect(scopeCapabilities('config')).toEqual({
      canAdd: true,
      canEdit: true,
      canRemove: true,
      canToggle: true,
    });
  });

  it('当前组句柄缺失时返回空列表而不是报错', () => {
    expect(collectDeclaredBackends(null)).toEqual([]);
  });
});

describe('resolveScopedBackends', () => {
  it('组已激活时只读组内权威声明，配置组副本不参与合并', () => {
    const h = handle([backend('live-1')], new Map());
    const view = resolveScopedBackends(h, {
      bootstrapBackends: [{ id: 'copy-only', type: 'Gitee' }],
    });

    expect(view.source).toBe('data-group');
    expect(view.rows.map(r => r.id)).toEqual(['live-1']);
    expect(view.bootstrap).toEqual([]);
  });

  it('不做并集：权威里已删除、仅存在于副本的 id 不得出现', () => {
    const h = handle([backend('b1')], new Map());
    const view = resolveScopedBackends(h, {
      bootstrapBackends: [{ id: 'b1', type: 'Gitee' }, { id: 'removed', type: 'Gitee' }],
    });

    expect(view.rows.map(r => r.id)).toEqual(['b1']);
    expect(JSON.stringify(view)).not.toContain('removed');
  });

  it('组未激活且副本有记录时回退为引导视图', () => {
    const view = resolveScopedBackends(null, {
      bootstrapBackends: [{ id: 'b1', type: 'Gitee' }],
    });

    expect(view.source).toBe('bootstrap');
    expect(view.rows).toEqual([]);
    expect(view.bootstrap).toEqual([{ id: 'b1', type: 'Gitee' }]);
  });

  it('组未激活且副本为空时没有可展示来源', () => {
    expect(resolveScopedBackends(null, { bootstrapBackends: [] }).source).toBe('none');
    expect(resolveScopedBackends(null, null).source).toBe('none');
  });
});
