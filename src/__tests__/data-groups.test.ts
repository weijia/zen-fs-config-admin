import { describe, it, expect, vi } from 'vitest';
import { activateDataGroups } from '../context/ConfigRepoContext';
import { isDataGroupPath, makeDataGroupPath, parseDataGroupPath } from '../data-group-path';
import type {
  AppDataGroup,
  AppDataGroupDescriptor,
  AppDataBackendDescriptor,
  BackendSyncState,
} from 'zen-fs-config';

// ---------------------------------------------------------------------------
// 假 repo
// ---------------------------------------------------------------------------

function makeBackend(id: string, type = 'RemoteStorage'): AppDataBackendDescriptor {
  return { id, type, options: { href: `user@${id}.example.com`, token: `tok-${id}` } };
}

interface FakeGroup extends AppDataGroup {
  groupId: string;
  appId: string;
  fs: any;
  disposed: number;
  _backends: AppDataBackendDescriptor[];
}

function makeGroup(
  id: string,
  backends: AppDataBackendDescriptor[],
  backendStates: BackendSyncState[] = backends.map(b => ({ backendId: b.id, pairId: `pair-${b.id}` })),
): FakeGroup {
  const state = { disposed: 0, backends };
  return {
    groupId: id,
    appId: 'admin',
    fs: { promises: { readdir: async () => [`${id}-file.txt`] } },
    get disposed() { return state.disposed; },
    getSyncStatuses: () => new Map(),
    getBackendSyncStates: () => new Map(backendStates.map(s => [s.backendId, s])),
    flush: async () => [],
    dispose: async () => { state.disposed++; },
    addBackend: async () => {},
    removeBackend: async () => {},
    listBackends: () => state.backends.filter(b => backendStates.find(s => s.backendId === b.id)?.pairId),
    listDeclaredBackends: () => state.backends,
  } as unknown as FakeGroup;
}

function makeFakeRepo(
  descriptors: AppDataGroupDescriptor[],
  opts: {
    failActivate?: string[];
    failList?: boolean;
    backendStates?: Record<string, BackendSyncState[]>;
  } = {},
) {
  const groups = new Map<string, FakeGroup>();
  for (const d of descriptors) groups.set(d.id, makeGroup(d.id, d.backends, opts.backendStates?.[d.id]));

  const calls = { list: 0, get: [] as string[] };

  return {
    calls,
    groups,
    listAppDataGroups: async (): Promise<AppDataGroupDescriptor[]> => {
      calls.list++;
      if (opts.failList) throw new Error('boom');
      return descriptors;
    },
    getAppDataGroup: async (id: string): Promise<AppDataGroup> => {
      calls.get.push(id);
      if (opts.failActivate?.includes(id)) throw new Error(`cannot activate ${id}`);
      const g = groups.get(id);
      if (!g) throw new Error(`App data group "${id}" not found`);
      return g;
    },
  };
}

// ---------------------------------------------------------------------------
// A. activateDataGroups（FR1.1 - FR1.5）
// ---------------------------------------------------------------------------

describe('activateDataGroups', () => {
  it('A1: 没有数据组时返回空数组', async () => {
    const repo = makeFakeRepo([]);
    const result = await activateDataGroups(repo as any);
    expect(result).toEqual([]);
    expect(repo.calls.list).toBe(1);
  });

  it('A2: 枚举并激活每个组，backends 来自 listDeclaredBackends()', async () => {
    const repo = makeFakeRepo([
      { id: 'g1', groupType: 'data-sync', backends: [makeBackend('b1')] },
      { id: 'g2', groupType: 'data-sync', backends: [makeBackend('b2'), makeBackend('b3')] },
    ]);
    const result = await activateDataGroups(repo as any);

    expect(repo.calls.list).toBe(1);
    expect(repo.calls.get).toEqual(['g1', 'g2']);
    expect(result.map(r => r.id)).toEqual(['g1', 'g2']);
    expect(result[0].backends.map(b => b.id)).toEqual(['b1']);
    expect(result[1].backends.map(b => b.id)).toEqual(['b2', 'b3']);
    expect(result.every(r => !r.error)).toBe(true);
  });

  it('A3: 单个组激活失败只记录 error，其它组正常', async () => {
    const repo = makeFakeRepo(
      [
        { id: 'ok', groupType: 'data-sync', backends: [makeBackend('b1')] },
        { id: 'bad', groupType: 'data-sync', backends: [makeBackend('b2')] },
      ],
      { failActivate: ['bad'] },
    );
    const result = await activateDataGroups(repo as any);

    expect(result).toHaveLength(2);
    expect(result.find(r => r.id === 'ok')?.error).toBeUndefined();
    expect(result.find(r => r.id === 'bad')?.error).toContain('cannot activate bad');
    // 失败组仍保留描述符里的后端信息，便于 UI 展示
    expect(result.find(r => r.id === 'bad')?.backends.map(b => b.id)).toEqual(['b2']);
  });

  it('A4: listAppDataGroups 抛错时返回空数组而不向上抛', async () => {
    const repo = makeFakeRepo([], { failList: true });
    await expect(activateDataGroups(repo as any)).resolves.toEqual([]);
  });

  it('A6: 声明但未连上的后端仍在 backends 中，并在 backendStates 带 error', async () => {
    const repo = makeFakeRepo(
      [{ id: 'g1', groupType: 'data-sync', backends: [makeBackend('b1'), makeBackend('b2')] }],
      {
        backendStates: {
          g1: [
            { backendId: 'b1', pairId: 'pair-b1' },
            { backendId: 'b2', error: { message: 'unreachable', timestamp: 1 } },
          ],
        },
      },
    );
    const result = await activateDataGroups(repo as any);

    // 声明视图：即使 b2 未连上也不能少显示
    expect(result[0].backends.map(b => b.id)).toEqual(['b1', 'b2']);
    expect(result[0].backendStates.find(s => s.backendId === 'b2')?.error?.message).toBe('unreachable');
  });

  it('A5: 返回的 group 句柄就是 repo 缓存的实例（不会重复创建 SyncPair）', async () => {
    const repo = makeFakeRepo([{ id: 'g1', groupType: 'data-sync', backends: [] }]);
    const first = await activateDataGroups(repo as any);
    const second = await activateDataGroups(repo as any);
    expect(second[0].group).toBe(first[0].group);
    expect(repo.groups.get('g1')?.disposed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. 数据组路径编解码（FR2.7）
// ---------------------------------------------------------------------------

describe('data group path helpers', () => {
  it('C1-C3: isDataGroupPath', () => {
    expect(isDataGroupPath('/@dg')).toBe(true);
    expect(isDataGroupPath('/@dg/g1/a.txt')).toBe(true);
    expect(isDataGroupPath('/admin/a.json')).toBe(false);
  });

  it('C4-C5: parseDataGroupPath', () => {
    expect(parseDataGroupPath('/@dg/g1/sub/a.txt')).toEqual({ groupId: 'g1', inner: '/sub/a.txt' });
    expect(parseDataGroupPath('/@dg/g1')).toEqual({ groupId: 'g1', inner: '/' });
    expect(parseDataGroupPath('/admin/a.json')).toBeNull();
  });

  it('C6-C7: makeDataGroupPath', () => {
    expect(makeDataGroupPath('g1', '/sub/a.txt')).toBe('/@dg/g1/sub/a.txt');
    expect(makeDataGroupPath('g1', '/')).toBe('/@dg/g1');
  });

  it('C8: 编解码往返一致', () => {
    const cases: [string, string][] = [
      ['g1', '/'],
      ['g1', '/a.txt'],
      ['group-2', '/deep/nested/file.json'],
    ];
    for (const [groupId, inner] of cases) {
      const parsed = parseDataGroupPath(makeDataGroupPath(groupId, inner))!;
      expect(parsed.groupId).toBe(groupId);
      expect(parsed.inner).toBe(inner);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Context 生命周期（FR1.7 / FR1.8）
// ---------------------------------------------------------------------------

describe('ConfigRepoProvider lifecycle', () => {
  it('B1/B2/B3: 挂载激活、卸载释放、reconnect 重新激活', async () => {
    // `createConfigRepo` 在这里被替换掉，避免依赖浏览器 IndexedDB
    vi.resetModules();
    const descriptors: AppDataGroupDescriptor[] = [
      { id: 'g1', groupType: 'data-sync', backends: [makeBackend('b1')] },
    ];
    const repo1 = makeFakeRepo(descriptors);
    const repo2 = makeFakeRepo(descriptors);

    let created = 0;
    vi.doMock('zen-fs-config', async () => {
      const actual: any = await vi.importActual('zen-fs-config');
      return {
        ...actual,
        createConfigRepo: async () => (created++ === 0 ? repo1 : repo2),
      };
    });

    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { act } = React;
    const { ConfigRepoProvider, useConfigRepo } = await import('../context/ConfigRepoContext');

    let ctx: any = null;
    function Probe() {
      ctx = useConfigRepo();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(ConfigRepoProvider, null, React.createElement(Probe)));
    });

    // B1: 挂载后自动激活
    expect(repo1.calls.list).toBeGreaterThan(0);
    expect(repo1.calls.get).toContain('g1');
    expect(ctx.dataGroups.map((g: any) => g.id)).toEqual(['g1']);

    // B4: getDataGroupFs 返回组 fs 的 promises
    expect(typeof ctx.getDataGroupFs('g1')?.readdir).toBe('function');
    expect(ctx.getDataGroupFs('nope')).toBeNull();

    // B3: reconnect → 新 repo 上重新激活
    await act(async () => { await ctx.reconnect(); });
    expect(repo2.calls.get).toContain('g1');
    expect(ctx.dataGroups.map((g: any) => g.id)).toEqual(['g1']);

    // B5: refreshDataGroups 重新枚举
    const before = repo2.calls.list;
    await act(async () => { await ctx.refreshDataGroups(); });
    expect(repo2.calls.list).toBe(before + 1);

    // B2: 卸载释放
    await act(async () => { root.unmount(); });
    expect(repo2.groups.get('g1')?.disposed).toBeGreaterThan(0);

    vi.doUnmock('zen-fs-config');
  });
});
