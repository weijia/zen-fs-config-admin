import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

/**
 * SyncTargetProvider 的自动打开时序测试：
 *   · 冷启动 admin 配置仓未就绪时不得发起实例创建（否则会误报「没有远端后端」）；
 *   · admin 就绪后 effect 重跑并自动打开；
 *   · Reconnect（repo 身份变化）后清除失败态并自动重试。
 *
 * 依赖的上下文用 vi.mock 替换成可变对象，只测试 Provider 自身的时序逻辑。
 */
const harness = vi.hoisted(() => ({
  config: {} as any,
  instances: {} as any,
}));

vi.mock('../context/ConfigRepoContext', () => ({ useConfigRepo: () => harness.config }));
vi.mock('../context/RepoInstancesContext', () => ({ useRepoInstances: () => harness.instances }));
vi.mock('../data-group-overview', () => ({
  collectDataGroupOverview: async () => ({ apps: [], total: 0 }),
}));
vi.mock('../descriptor-cleanup', () => ({ deleteDataGroupDescriptor: async () => {} }));

import { SyncTargetProvider, useSyncTarget } from '../context/SyncTargetContext';

const STORAGE_KEY = 'zen-fs-config-admin:selected-group';

/** 每次渲染都记录当前上下文快照，供断言使用。 */
let probe: { error: string | null; ready: boolean; opening: boolean } = {
  error: null,
  ready: false,
  opening: false,
};

function Probe() {
  const { error, ready, opening } = useSyncTarget();
  probe = { error, ready, opening };
  return null;
}

let container: HTMLDivElement;
let root: Root;

function renderTree(path = '/dashboard') {
  return act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <SyncTargetProvider>
          <Probe />
        </SyncTargetProvider>
      </MemoryRouter>,
    );
  });
}

/** 冲刷 runOpen 内部的 promise 链。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function fakeRepo(tag: string) {
  return {
    tag,
    rootFS: { promises: {} },
    getSyncStatuses: () => new Map(),
    listDeclaredBackends: () => [],
  } as any;
}

function baseInstances(createInstance: ReturnType<typeof vi.fn>) {
  return {
    instances: [],
    errors: {},
    creating: {},
    revision: 0,
    openProgress: {},
    maxInstances: 3,
    createInstance,
    activateGroup: vi.fn(async () => {}),
    getInstance: () => undefined,
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, 'data:app-a:g1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SyncTargetProvider 自动打开时序', () => {
  it('冷启动 admin 未就绪：不创建实例、不报误导性错误；就绪后自动打开', async () => {
    const createInstance = vi.fn(async () => ({}));
    harness.config = { repo: null, dataGroups: [], refreshDataGroups: async () => {} };
    harness.instances = baseInstances(createInstance);

    await renderTree();
    await flush();

    expect(createInstance).not.toHaveBeenCalled();
    expect(probe.error).toBeNull();

    // admin 配置仓就绪：effect 因 repo 变化重跑，自动打开选中的数据组。
    harness.config = { ...harness.config, repo: fakeRepo('A') };
    await renderTree();
    await flush();

    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(createInstance).toHaveBeenCalledWith('app-a', 'g1');
    expect(probe.error).toBeNull();
  });

  it('打开失败后 repo 变化（Reconnect）：清除失败态并自动重试成功', async () => {
    const createInstance = vi
      .fn()
      .mockRejectedValueOnce(new Error('连接超时'))
      .mockResolvedValueOnce({});
    harness.config = { repo: fakeRepo('A'), dataGroups: [], refreshDataGroups: async () => {} };
    harness.instances = baseInstances(createInstance);

    await renderTree();
    await flush();

    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(probe.error).toBe('连接超时');

    // Reconnect：repo 换成新对象，失败标记应被清除并自动重试。
    harness.config = { ...harness.config, repo: fakeRepo('B') };
    await renderTree();
    await flush();

    expect(createInstance).toHaveBeenCalledTimes(2);
    expect(probe.error).toBeNull();
  });
});
