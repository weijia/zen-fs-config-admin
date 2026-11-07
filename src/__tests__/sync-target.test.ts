import { describe, it, expect } from 'vitest';
import {
  collectSyncTargets,
  DEFAULT_SYNC_TARGET_KEY,
  parseTargetKey,
  targetKey,
  targetPathPrefix,
  type SyncTargetInstanceSnapshot,
} from '../sync-target';
import type { DataGroupOverview, DataGroupOverviewEntry } from '../data-group-overview';

function entry(appId: string, id: string, overrides: Partial<DataGroupOverviewEntry> = {}): DataGroupOverviewEntry {
  return {
    appId,
    id,
    descriptorId: id,
    name: `${id} 组`,
    groupType: 'data-sync',
    backendsCount: 2,
    backendsSource: 'data-group',
    source: 'config',
    parsed: true,
    isDataSync: true,
    problem: null,
    ...overrides,
  };
}

function overview(apps: Record<string, DataGroupOverviewEntry[]>): DataGroupOverview {
  const list = Object.entries(apps).map(([appId, entries]) => ({ appId, entries }));
  return { apps: list, total: list.reduce((n, a) => n + a.entries.length, 0) };
}

const adminInstance: SyncTargetInstanceSnapshot = {
  appId: 'admin',
  open: true,
  creating: false,
  backendsCount: 2,
  pairCount: 2,
  watchingCount: 0,
  groups: [],
};

describe('sync-target 地址', () => {
  it('配置组只有一个地址 `config`，旧地址归一化后仍是同一个 target', () => {
    expect(targetKey({ kind: 'config', appId: 'admin', groupId: null })).toBe('config');
    expect(targetKey({ kind: 'data', appId: 'shop', groupId: 'g1' })).toBe('data:shop:g1');
    expect(parseTargetKey('config')).toEqual({ kind: 'config', appId: 'admin', groupId: null });
    // 旧格式 config:<appId> 一律归一到唯一的配置组，不再指向不存在的 target。
    expect(parseTargetKey('config:shop')).toEqual({ kind: 'config', appId: 'admin', groupId: null });
    expect(targetKey(parseTargetKey('config:shop')!)).toBe('config');
    expect(parseTargetKey('data:shop:g1')).toEqual({ kind: 'data', appId: 'shop', groupId: 'g1' });
    expect(parseTargetKey('data:shop')).toBeNull();
    expect(parseTargetKey('')).toBeNull();
    expect(DEFAULT_SYNC_TARGET_KEY).toBe('config');
  });

  it('Files 树路径前缀按组来源区分', () => {
    expect(targetPathPrefix({ kind: 'config', appId: 'admin', groupId: null })).toBe('');
    expect(targetPathPrefix({ kind: 'data', appId: 'admin', groupId: 'g1' })).toBe('/@dg/g1');
    expect(targetPathPrefix({ kind: 'data', appId: 'shop', groupId: 'g1' })).toBe('/@adg/shop/g1');
  });
});

describe('collectSyncTargets', () => {
  it('只有一行配置组，数据组平铺；appId 不产生额外行', () => {
    const targets = collectSyncTargets(
      overview({
        admin: [entry('admin', 'g1')],
        shop: [entry('shop', 'g2')],
        retire: [entry('retire', 'g3')],
      }),
      [adminInstance],
    );
    const configs = targets.filter(t => t.ref.kind === 'config');
    expect(configs).toHaveLength(1);
    expect(configs[0].key).toBe('config');
    expect(configs[0].label).toBe('配置同步组');
    expect(configs[0].backendsCount).toBe(2);
    expect(configs[0].detail).toContain('2 个后端');
    expect(targets.length).toBe(4);
    expect(targets.slice(1).map(t => t.key)).toEqual(['data:admin:g1', 'data:retire:g3', 'data:shop:g2']);
  });

  it('数据组：描述符存在即可选中；已激活则带后端数与同步对状态', () => {
    const targets = collectSyncTargets(
      overview({ admin: [entry('admin', 'g1')], shop: [entry('shop', 'g2')] }),
      [
        adminInstance,
        {
          appId: 'shop',
          open: true,
          creating: false,
          backendsCount: 3,
          pairCount: 1,
          watchingCount: 1,
          groups: [{
            appId: 'shop',
            groupId: 'g2',
            name: '真实组名',
            backendsCount: 3,
            pairCount: 2,
            watchingCount: 1,
            activated: true,
          }],
        },
      ],
    );

    const adminGroup = targets.find(t => t.key === 'data:admin:g1');
    expect(adminGroup?.openState).toBe('closed');
    expect(adminGroup?.backendsCount).toBe(2);
    expect(adminGroup?.detail).toContain('首次选择将建立实例并同步');

    const shopGroup = targets.find(t => t.key === 'data:shop:g2');
    expect(shopGroup?.openState).toBe('open');
    expect(shopGroup?.label).toBe('真实组名');
    expect(shopGroup?.backendsCount).toBe(3);
    expect(shopGroup?.health).toBe('syncing');
    expect(shopGroup?.detail).toContain('3 个后端');
    expect(shopGroup?.detail).toContain('2 对');
  });

  it('同一 appId 的多个组都平铺出现，未激活组也保留', () => {
    const targets = collectSyncTargets(
      overview({
        admin: [entry('admin', 'a'), entry('admin', 'b')],
        shop: [entry('shop', 'c')],
      }),
      [adminInstance],
    );
    const dataKeys = targets.filter(t => t.ref.kind === 'data').map(t => t.key);
    expect(dataKeys).toEqual(['data:admin:a', 'data:admin:b', 'data:shop:c']);
    expect(targets[0].key).toBe('config');
  });

  it('解析失败的描述符也列出，但标记为不可打开', () => {
    const targets = collectSyncTargets(
      overview({
        admin: [
          entry('admin', 'ok'),
          entry('admin', 'bad', { parsed: false, isDataSync: false, problem: 'JSON 解析失败（缺少闭合括号）' }),
          entry('admin', 'other', { groupType: 'other', isDataSync: false }),
        ],
      }),
      [adminInstance],
    );
    const dataKeys = targets.filter(t => t.ref.kind === 'data').map(t => t.key);
    expect(dataKeys).toEqual(['data:admin:bad', 'data:admin:ok']);

    const bad = targets.find(t => t.key === 'data:admin:bad');
    expect(bad?.openState).toBe('invalid');
    expect(bad?.health).toBe('error');
    expect(bad?.detail).toContain('JSON 解析失败');
    expect(bad?.error).toContain('缺少闭合括号');
  });
});
