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

describe('sync-target 地址', () => {
  it('key 往返一致，非法地址返回 null', () => {
    expect(targetKey({ kind: 'config', appId: 'admin', groupId: null })).toBe('config:admin');
    expect(targetKey({ kind: 'data', appId: 'shop', groupId: 'g1' })).toBe('data:shop:g1');
    expect(parseTargetKey('data:shop:g1')).toEqual({ kind: 'data', appId: 'shop', groupId: 'g1' });
    expect(parseTargetKey('config:admin')).toEqual({ kind: 'config', appId: 'admin', groupId: null });
    expect(parseTargetKey('data:shop')).toBeNull();
    expect(parseTargetKey('')).toBeNull();
    expect(DEFAULT_SYNC_TARGET_KEY).toBe('config:admin');
  });

  it('Files 树路径前缀按组来源区分', () => {
    expect(targetPathPrefix({ kind: 'config', appId: 'admin', groupId: null })).toBe('');
    expect(targetPathPrefix({ kind: 'data', appId: 'admin', groupId: 'g1' })).toBe('/@dg/g1');
    expect(targetPathPrefix({ kind: 'data', appId: 'shop', groupId: 'g1' })).toBe('/@adg/shop/g1');
  });
});

describe('collectSyncTargets', () => {
  const adminInstance: SyncTargetInstanceSnapshot = {
    appId: 'admin',
    open: true,
    creating: false,
    pairCount: 2,
    watchingCount: 0,
    groups: [],
  };

  it('配置组：admin 常驻打开；只有描述符的 appId 显示为未打开', () => {
    const targets = collectSyncTargets(
      overview({ admin: [], shop: [entry('shop', 'g1')] }),
      [adminInstance],
    );
    const admin = targets.find(t => t.key === 'config:admin');
    expect(admin?.openState).toBe('open');
    expect(admin?.ref.kind).toBe('config');

    const shopConfig = targets.find(t => t.key === 'config:shop');
    expect(shopConfig?.openState).toBe('closed');
    expect(shopConfig?.detail).toBe('首次选择将建立实例并同步');
  });

  it('数据组：描述符存在即可选中；已激活则带同步对状态', () => {
    const targets = collectSyncTargets(
      overview({ admin: [entry('admin', 'g1')], shop: [entry('shop', 'g2')] }),
      [
        adminInstance,
        {
          appId: 'shop',
          open: true,
          creating: false,
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

    const shopGroup = targets.find(t => t.key === 'data:shop:g2');
    expect(shopGroup?.openState).toBe('open');
    expect(shopGroup?.label).toBe('真实组名');
    expect(shopGroup?.backendsCount).toBe(3);
    expect(shopGroup?.health).toBe('syncing');
    expect(shopGroup?.detail).toContain('2 对');
  });

  it('同一 appId 的多个组都出现，未激活组也保留', () => {
    const targets = collectSyncTargets(
      overview({
        admin: [entry('admin', 'a'), entry('admin', 'b')],
        shop: [entry('shop', 'c')],
      }),
      [adminInstance],
    );
    const dataKeys = targets.filter(t => t.ref.kind === 'data').map(t => t.key);
    expect(dataKeys).toEqual(['data:admin:a', 'data:admin:b', 'data:shop:c']);
    // 配置组排在数据组前面，admin 配置组在最前。
    expect(targets[0].key).toBe('config:admin');
  });

  it('描述符异常或非 data-sync 的条目不进入数据组列表', () => {
    const targets = collectSyncTargets(
      overview({
        admin: [
          entry('admin', 'ok'),
          entry('admin', 'bad', { parsed: false, problem: 'JSON 解析失败' }),
          entry('admin', 'other', { groupType: 'other', isDataSync: false }),
        ],
      }),
      [adminInstance],
    );
    const dataKeys = targets.filter(t => t.ref.kind === 'data').map(t => t.key);
    expect(dataKeys).toEqual(['data:admin:ok']);
  });
});
