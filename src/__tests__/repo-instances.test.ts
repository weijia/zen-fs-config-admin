import { describe, it, expect, vi } from 'vitest';
import type { IConfigRepo } from 'zen-fs-config';
import { RepoInstanceRegistry, type RemoteBackendInfo } from '../repo-instances';

/** 记录调用的假 repo / group，用于验证「写操作落到正确实例」。 */
interface FakeRepo {
  appId: string;
  calls: string[];
  descriptors: any[];
  statuses: Map<string, any>;
  backendStates: Map<string, any>;
  groups: Map<string, any>;
  flush: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  listAppDataGroups: ReturnType<typeof vi.fn>;
  getAppDataGroup: ReturnType<typeof vi.fn>;
  updateAppDataGroupName: ReturnType<typeof vi.fn>;
  replaceAppDataGroupBackend: ReturnType<typeof vi.fn>;
  removeAppDataGroup: ReturnType<typeof vi.fn>;
  getSyncStatuses: () => Map<string, any>;
  getBackendSyncStates: () => Map<string, any>;
}

/** 假组句柄：dispose 后 add/remove/flush 会像真实库一样抛错。 */
function makeFakeGroup(groupId: string, backends: any[], calls: string[]) {
  const group: any = {
    id: groupId,
    disposed: false,
    listBackends: () => backends,
    listDeclaredBackends: () => backends,
    getBackendSyncStates: () => new Map(backends.map(b => [b.id, { backendId: b.id, pairId: `pair-${b.id}` }])),
    addBackend: vi.fn(async (id: string, type: string, opts: Record<string, unknown>) => {
      if (group.disposed) throw new Error('DataSyncGroup has been disposed');
      calls.push(`group:${groupId}:addBackend:${id}:${type}:${JSON.stringify(opts)}`);
      backends.push({ id, type, options: opts });
    }),
    removeBackend: vi.fn(async (id: string) => {
      if (group.disposed) throw new Error('DataSyncGroup has been disposed');
      calls.push(`group:${groupId}:removeBackend:${id}`);
      const idx = backends.findIndex(b => b.id === id);
      if (idx >= 0) backends.splice(idx, 1);
    }),
    flush: vi.fn(async () => {
      if (group.disposed) throw new Error('DataSyncGroup has been disposed');
      calls.push(`group:${groupId}:flush`);
    }),
    dispose: vi.fn(async () => {
      group.disposed = true;
      calls.push(`group:${groupId}:dispose`);
    }),
  };
  return group;
}

function makeFakeRepo(
  appId: string,
  options: {
    descriptors?: any[];
    syncError?: string;
    backendError?: string;
    flushError?: string;
    watching?: boolean;
  } = {},
): FakeRepo {
  const calls: string[] = [];
  const descriptors = options.descriptors ?? [
    { id: 'g1', name: 'Group 1', groupType: 'data-sync', backends: [{ id: 'b1' }] },
  ];
  const statuses = new Map<string, any>([
    ['pair-1', {
      pairId: 'pair-1',
      targetName: 'g1',
      watching: options.watching ?? true,
      lastResult: options.syncError ? undefined : {},
    }],
  ]);
  const backendStates = new Map<string, any>();
  if (options.backendError) {
    backendStates.set('gitee', { backendId: 'gitee', error: new Error(options.backendError) });
  }

  const groups = new Map<string, any>();
  for (const desc of descriptors) {
    groups.set(desc.id, makeFakeGroup(desc.id, [...(desc.backends ?? [])], calls));
  }

  const repo: FakeRepo = {
    appId,
    calls,
    descriptors,
    statuses,
    backendStates,
    groups,
    flush: vi.fn(async () => {
      calls.push('flush');
      if (options.flushError) throw new Error(options.flushError);
    }),
    dispose: vi.fn(async () => { calls.push('dispose'); }),
    listAppDataGroups: vi.fn(async () => descriptors),
    getAppDataGroup: vi.fn(async (id: string) => {
      const group = groups.get(id);
      if (!group) throw new Error(`group ${id} missing`);
      return group;
    }),
    updateAppDataGroupName: vi.fn(async (id: string, name: string) => {
      calls.push(`updateAppDataGroupName:${id}:${name}`);
    }),
    replaceAppDataGroupBackend: vi.fn(async (
      id: string,
      backendId: string,
      type: string,
      backendOptions: Record<string, unknown> = {},
      description?: string,
    ) => {
      calls.push(`replaceAppDataGroupBackend:${id}:${backendId}:${type}`);
      const old = groups.get(id);
      const declared = old ? old.listDeclaredBackends() as any[] : [];
      // 模拟真实行为：dispose 旧组，返回一个全新的组对象。
      if (old) await old.dispose();
      const next = makeFakeGroup(
        id,
        declared.map(b => b.id === backendId ? { ...b, type, options: backendOptions, description } : b),
        calls,
      );
      groups.set(id, next);
      return next;
    }),
    removeAppDataGroup: vi.fn(async (id: string) => {
      calls.push(`removeAppDataGroup:${id}`);
      repo.descriptors = repo.descriptors.filter(d => d.id !== id);
    }),
    getSyncStatuses: () => statuses,
    getBackendSyncStates: () => backendStates,
  };
  return repo;
}

const REMOTE_BACKEND: RemoteBackendInfo = {
  id: 'gitee',
  type: 'Gitee',
  options: { owner: 'o', repo: 'r' },
};

function makeRegistry(overrides: {
  getRemoteBackend?: () => Promise<RemoteBackendInfo | null>;
  maxInstances?: number;
} = {}) {
  const created: FakeRepo[] = [];
  const registry = new RepoInstanceRegistry({
    createRepo: async (appId) => {
      const repo = makeFakeRepo(appId);
      created.push(repo);
      return repo as unknown as IConfigRepo;
    },
    getRemoteBackend: overrides.getRemoteBackend ?? (async () => REMOTE_BACKEND),
    maxInstances: overrides.maxInstances,
  });
  return { registry, created };
}

describe('RepoInstanceRegistry', () => {
  it('懒创建只建一次（顺序 + 并发调用）', async () => {
    const { registry, created } = makeRegistry();

    const first = await registry.create('app-a');
    expect(registry.has('app-a')).toBe(true);
    expect(created).toHaveLength(1);

    const second = await registry.create('app-a');
    expect(second).toBe(first);
    expect(created).toHaveLength(1);

    const [c1, c2] = await Promise.all([
      registry.create('app-b'),
      registry.create('app-b'),
    ]);
    expect(c1).toBe(c2);
    expect(created.filter(r => r.appId === 'app-b')).toHaveLength(1);
  });

  it('创建时只激活选中的组，不拉起该 appId 的全部组', async () => {
    const descriptors = [
      { id: 'g1', name: 'Group 1', groupType: 'data-sync', backends: [] },
      { id: 'g2', name: 'Group 2', groupType: 'data-sync', backends: [] },
    ];
    const repo = makeFakeRepo('app-a', { descriptors });
    const registry = new RepoInstanceRegistry({
      createRepo: async () => repo as unknown as IConfigRepo,
      getRemoteBackend: async () => REMOTE_BACKEND,
    });

    const instance = await registry.create('app-a', 'g2');
    expect(instance.groups.map(g => g.id)).toEqual(['g2']);
    expect(repo.getAppDataGroup).toHaveBeenCalledWith('g2');
    expect(repo.getAppDataGroup).not.toHaveBeenCalledWith('g1');
  });

  it('同一实例切换组时按需激活单个组', async () => {
    const descriptors = [
      { id: 'g1', name: 'Group 1', groupType: 'data-sync', backends: [] },
      { id: 'g2', name: 'Group 2', groupType: 'data-sync', backends: [] },
    ];
    const repo = makeFakeRepo('app-a', { descriptors });
    const registry = new RepoInstanceRegistry({
      createRepo: async () => repo as unknown as IConfigRepo,
      getRemoteBackend: async () => REMOTE_BACKEND,
    });

    await registry.create('app-a', 'g1');
    // 同 appId 已打开：切换组时不会再建实例。
    await registry.create('app-a', 'g2');
    await registry.activateGroup('app-a', 'g2');

    expect(registry.get('app-a')?.groups.map(g => g.id).sort()).toEqual(['g1', 'g2']);
    expect(repo.getAppDataGroup).toHaveBeenCalledTimes(2);
  });

  it('并发上限：超出时提示先释放，且不会创建新 repo', async () => {
    const { registry, created } = makeRegistry({ maxInstances: 3 });
    await registry.create('a');
    await registry.create('b');
    await registry.create('c');

    await expect(registry.create('d')).rejects.toThrow(/实例数量已达上限（3）/);
    expect(created.map(r => r.appId)).toEqual(['a', 'b', 'c']);
  });

  it('释放：先 flush 再 dispose，释放后回到未创建状态，可再次创建', async () => {
    const { registry, created } = makeRegistry();
    await registry.create('app-a');
    const repo = created[0];

    await registry.release('app-a');
    const flushIdx = repo.calls.indexOf('flush');
    const disposeIdx = repo.calls.indexOf('dispose');
    expect(flushIdx).toBeGreaterThanOrEqual(0);
    expect(disposeIdx).toBeGreaterThan(flushIdx);

    expect(registry.has('app-a')).toBe(false);
    expect(registry.status('app-a')).toBeNull();

    const again = await registry.create('app-a');
    expect(created).toHaveLength(2);
    expect(again.repo).toBe(created[1] as unknown as IConfigRepo);
  });

  it('flush 失败时保留实例并抛出具体原因，避免丢数据', async () => {
    const { registry, created } = makeRegistry();
    await registry.create('app-a');
    const repo = created[0];
    repo.flush.mockRejectedValueOnce(new Error('network down'));

    await expect(registry.release('app-a')).rejects.toThrow(/flush 未成功.*network down/);
    expect(registry.has('app-a')).toBe(true);
    expect(repo.calls).not.toContain('dispose');
  });

  it('写操作落到正确实例的 storage', async () => {
    const { registry, created } = makeRegistry();
    await registry.create('app-a');
    await registry.create('app-b');
    const repoA = created[0];
    const repoB = created[1];

    await registry.renameGroup('app-b', 'g1', '新名字');
    expect(repoB.updateAppDataGroupName).toHaveBeenCalledWith('g1', '新名字');
    expect(repoA.updateAppDataGroupName).not.toHaveBeenCalled();

    await registry.addBackend('app-b', 'g1', 'b2', 'RemoteStorage', { url: 'x' });
    expect(repoB.groups.get('g1').addBackend).toHaveBeenCalledWith('b2', 'RemoteStorage', { url: 'x' }, undefined);
    expect(repoA.groups.get('g1').addBackend).not.toHaveBeenCalled();

    await registry.replaceBackend('app-a', 'g1', 'b1', 'Gitee', { owner: 'o2' });
    expect(repoA.replaceAppDataGroupBackend).toHaveBeenCalledWith('g1', 'b1', 'Gitee', { owner: 'o2' }, undefined);
    expect(repoB.replaceAppDataGroupBackend).not.toHaveBeenCalled();

    await registry.removeGroup('app-a', 'g1');
    expect(repoA.removeAppDataGroup).toHaveBeenCalledWith('g1');
    expect(repoB.removeAppDataGroup).not.toHaveBeenCalled();
  });

  it('replaceBackend 后注册表持有新句柄，旧句柄不再被使用', async () => {
    const { registry, created } = makeRegistry();
    await registry.create('app-a');
    const repo = created[0];
    const before = registry.get('app-a')!.groups.find(g => g.id === 'g1')!;
    const oldGroup = before.group;
    expect((oldGroup as any).disposed).toBe(false);

    await registry.replaceBackend('app-a', 'g1', 'b1', 'Gitee', { owner: 'o2' }, 'new opts');

    const after = registry.get('app-a')!.groups.find(g => g.id === 'g1')!;
    expect(after.group).not.toBe(oldGroup);
    expect(after.group).toBe(repo.groups.get('g1'));
    expect((oldGroup as any).disposed).toBe(true);

    const b1 = after.backends.find(b => b.id === 'b1') as any;
    expect(b1.type).toBe('Gitee');
    expect(b1.options).toEqual({ owner: 'o2' });
    expect(b1.description).toBe('new opts');

    await registry.addBackend('app-a', 'g1', 'b2', 'RemoteStorage', { url: 'x' });
    expect((after.group as any).addBackend).toHaveBeenCalledWith('b2', 'RemoteStorage', { url: 'x' }, undefined);
    expect((oldGroup as any).addBackend).not.toHaveBeenCalled();

    await registry.removeBackend('app-a', 'g1', 'b2');
    expect((after.group as any).removeBackend).toHaveBeenCalledWith('b2');
    expect((oldGroup as any).removeBackend).not.toHaveBeenCalled();

    await (after.group as any).flush();
    expect((oldGroup as any).flush).not.toHaveBeenCalled();
  });

  it('未创建的实例执行写操作会给出明确错误', async () => {
    const { registry } = makeRegistry();
    await expect(registry.renameGroup('app-x', 'g1', 'n')).rejects.toThrow(/尚未打开/);
  });

  it('创建失败：factory 抛错时带上原因且不注册实例', async () => {
    const registry = new RepoInstanceRegistry({
      createRepo: async () => { throw new Error('credential missing'); },
      getRemoteBackend: async () => REMOTE_BACKEND,
    });
    await expect(registry.create('app-a')).rejects.toThrow(/credential missing/);
    expect(registry.has('app-a')).toBe(false);
  });

  it('创建失败：没有远端后端时给出明确错误', async () => {
    const registry = new RepoInstanceRegistry({
      createRepo: async () => makeFakeRepo('x') as unknown as IConfigRepo,
      getRemoteBackend: async () => null,
    });
    await expect(registry.create('app-a')).rejects.toThrow(/没有可用的远端配置后端/);
    expect(registry.has('app-a')).toBe(false);
  });

  it('创建失败：首次同步尚未完成时提示稍后重试，而不是归因凭据无效', async () => {
    const created: FakeRepo[] = [];
    const registry = new RepoInstanceRegistry({
      createRepo: async appId => {
        const repo = makeFakeRepo(appId, { syncError: 'failed' });
        created.push(repo);
        return repo as unknown as IConfigRepo;
      },
      getRemoteBackend: async () => REMOTE_BACKEND,
    });

    const err = await registry.create('app-a').catch((e: Error) => e);
    if (!(err instanceof Error)) throw new Error('create() 未按预期抛出错误');
    expect(err.message).toMatch(/首次同步尚未完成，请稍后重试/);
    expect(err.message).not.toMatch(/凭据无效/);
    expect(created[0].dispose).toHaveBeenCalled();
    expect(registry.has('app-a')).toBe(false);
  });

  it('创建失败：后端凭据缺失（backendState error）时抛出原因并 dispose', async () => {
    const created: FakeRepo[] = [];
    const registry = new RepoInstanceRegistry({
      createRepo: async appId => {
        const repo = makeFakeRepo(appId, { backendError: 'missing token' });
        created.push(repo);
        return repo as unknown as IConfigRepo;
      },
      getRemoteBackend: async () => REMOTE_BACKEND,
    });

    await expect(registry.create('app-a')).rejects.toThrow(/missing token/);
    expect(created[0].dispose).toHaveBeenCalled();
  });

  it('admin 不能通过注册表创建', async () => {
    const { registry } = makeRegistry();
    await expect(registry.create('admin')).rejects.toThrow(/admin 实例/);
  });
});
