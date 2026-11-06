import { describe, it, expect } from 'vitest';
import {
  collectDataGroupOverview,
  APP_DATA_GROUPS_DIR,
  LEGACY_APP_DATA_GROUPS_DIR,
} from '../data-group-overview';

// ---------------------------------------------------------------------------
// 假的仓库根 fs：只实现 readdir / readFile，按绝对路径模拟目录结构
// ---------------------------------------------------------------------------

function makeFakeFs(files: Record<string, string>) {
  const promises = {
    readdir: async (dir: string): Promise<string[]> => {
      const prefix = dir === '/' ? '/' : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest) continue;
        names.add(rest.split('/')[0]);
      }
      if (names.size === 0) throw new Error(`ENOENT: no such directory ${dir}`);
      return Array.from(names);
    },
    readFile: async (p: string): Promise<string> => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
  return { promises };
}

const config = (appId: string, file: string) => `${APP_DATA_GROUPS_DIR}/${appId}/${file}`;
const legacy = (appId: string, file: string) => `${LEGACY_APP_DATA_GROUPS_DIR}/${appId}/${file}`;

const descriptor = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, groupType: 'data-sync', backends: [], ...extra });

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

describe('collectDataGroupOverview 枚举', () => {
  it('枚举所有 appId 子目录（不只 admin）并按名称排序', async () => {
    const fs = makeFakeFs({
      [config('admin', 'a.json')]: descriptor('a', { name: 'Alpha', backends: [{ id: 'b1', type: 'Gitee' }] }),
      [config('dir-struct-gen', 'y.json')]: descriptor('y', { name: 'Yankee' }),
      [config('dir-struct-gen', 'x.json')]: descriptor('x', { name: 'Xray' }),
    });

    const overview = await collectDataGroupOverview(fs.promises);

    expect(overview.total).toBe(3);
    expect(overview.apps.map(a => a.appId)).toEqual(['admin', 'dir-struct-gen']);
    expect(overview.apps[1].entries.map(e => e.id)).toEqual(['x', 'y']);
    expect(overview.apps[0].entries[0]).toMatchObject({
      id: 'a',
      name: 'Alpha',
      backendsCount: 1,
      source: 'config',
      parsed: true,
      isDataSync: true,
      problem: null,
    });
  });

  it('两个布局都没有目录时返回空总览', async () => {
    const fs = makeFakeFs({});
    await expect(collectDataGroupOverview(fs.promises)).resolves.toEqual({ apps: [], total: 0 });
  });

  it('没有 fs 时返回空总览（不抛错）', async () => {
    await expect(collectDataGroupOverview(null)).resolves.toEqual({ apps: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// `.config` 优先 + 去重
// ---------------------------------------------------------------------------

describe('collectDataGroupOverview 布局优先级', () => {
  it('.config 与 .meta 同 appId + id：以 .config 为准且只保留一条', async () => {
    const fs = makeFakeFs({
      [config('admin', 'g1.json')]: descriptor('g1', { name: 'New Name' }),
      [legacy('admin', 'g1.json')]: descriptor('g1', { name: 'Legacy Name' }),
      [legacy('admin', 'g2.json')]: descriptor('g2', { name: 'Meta Only' }),
    });

    const overview = await collectDataGroupOverview(fs.promises);

    expect(overview.total).toBe(2);
    expect(overview.apps).toHaveLength(1);
    const byId = new Map(overview.apps[0].entries.map(e => [e.id, e]));
    expect(byId.get('g1')).toMatchObject({ name: 'New Name', source: 'config' });
    expect(byId.get('g2')).toMatchObject({ name: 'Meta Only', source: 'meta' });
  });

  it('legacy 布局的文件在 .config 缺失时兜底生效', async () => {
    const fs = makeFakeFs({
      [legacy('dir-struct-gen', 'app-data.json')]: descriptor('app-data', { name: 'App Data' }),
    });

    const overview = await collectDataGroupOverview(fs.promises);
    expect(overview.apps[0].entries[0]).toMatchObject({
      appId: 'dir-struct-gen',
      id: 'app-data',
      source: 'meta',
      parsed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 权威声明数优先，引导副本回退
// ---------------------------------------------------------------------------

describe('collectDataGroupOverview 后端数量来源', () => {
  it('有权威声明数时优先使用，并标记 backendsSource=data-group', async () => {
    const fs = makeFakeFs({
      [config('admin', 'g1.json')]: descriptor('g1', { name: 'G1', backends: [{ id: 'stale' }] }),
    });

    const overview = await collectDataGroupOverview(
      fs.promises,
      new Map([['admin/g1', 3]]),
    );

    expect(overview.apps[0].entries[0]).toMatchObject({
      id: 'g1',
      backendsCount: 3,
      backendsSource: 'data-group',
    });
  });

  it('权威声明数为 0 时不被引导副本覆盖', async () => {
    const fs = makeFakeFs({
      [config('admin', 'g1.json')]: descriptor('g1', { backends: [{ id: 'stale' }] }),
    });

    const overview = await collectDataGroupOverview(fs.promises, new Map([['admin/g1', 0]]));
    expect(overview.apps[0].entries[0]).toMatchObject({ backendsCount: 0, backendsSource: 'data-group' });
  });

  it('无权威来源时回退引导副本，并标记 backendsSource=bootstrap', async () => {
    const fs = makeFakeFs({
      [config('admin', 'g1.json')]: descriptor('g1', { backends: [{ id: 'b1' }, { id: 'b2' }] }),
    });

    const overview = await collectDataGroupOverview(fs.promises);
    expect(overview.apps[0].entries[0]).toMatchObject({ backendsCount: 2, backendsSource: 'bootstrap' });

    // 只命中的其它 appId 不应被误用为权威来源
    const partial = await collectDataGroupOverview(fs.promises, new Map([['other/g1', 5]]));
    expect(partial.apps[0].entries[0]).toMatchObject({ backendsCount: 2, backendsSource: 'bootstrap' });
  });
});

// ---------------------------------------------------------------------------
// 容错：坏 JSON / 缺字段 / 读取失败
// ---------------------------------------------------------------------------

describe('collectDataGroupOverview 容错', () => {
  it('坏 JSON 不丢弃，标记为无法解析', async () => {
    const fs = makeFakeFs({
      [config('admin', 'broken.json')]: '{ "id": "broken", ',
      [config('admin', 'ok.json')]: descriptor('ok'),
    });

    const overview = await collectDataGroupOverview(fs.promises);
    const entries = overview.apps[0].entries;

    expect(entries).toHaveLength(2);
    const broken = entries.find(e => e.id === 'broken')!;
    expect(broken.parsed).toBe(false);
    expect(broken.isDataSync).toBe(false);
    expect(broken.groupType).toBeNull();
    expect(broken.problem).toContain('无法解析');
    expect(entries.find(e => e.id === 'ok')?.problem).toBeNull();
  });

  it('缺 id / 缺 groupType 分别给出明确原因', async () => {
    const fs = makeFakeFs({
      [config('admin', 'no-id.json')]: JSON.stringify({ groupType: 'data-sync', backends: [] }),
      [config('admin', 'no-type.json')]: JSON.stringify({ id: 'no-type', backends: [] }),
    });

    const overview = await collectDataGroupOverview(fs.promises);
    const byId = new Map(overview.apps[0].entries.map(e => [e.id, e]));

    expect(byId.get('no-id')?.problem).toContain('缺少 id');
    expect(byId.get('no-type')?.problem).toContain('缺少 groupType');
    expect(byId.get('no-type')?.descriptorId).toBe('no-type');
  });

  it('描述符不是 JSON 对象时标记为无法解析', async () => {
    const fs = makeFakeFs({ [config('admin', 'array.json')]: '[]' });

    const overview = await collectDataGroupOverview(fs.promises);
    expect(overview.apps[0].entries[0].problem).toContain('不是 JSON 对象');
  });

  it('文件读取失败也保留条目并标记原因', async () => {
    const base = makeFakeFs({ [config('admin', 'x.json')]: descriptor('x') });
    const fs = {
      promises: {
        readdir: base.promises.readdir,
        readFile: async (): Promise<string> => { throw new Error('disk error'); },
      },
    };

    const overview = await collectDataGroupOverview(fs.promises);
    expect(overview.apps[0].entries[0]).toMatchObject({ id: 'x', parsed: false, source: 'config' });
    expect(overview.apps[0].entries[0].problem).toContain('无法解析');
  });
});

// ---------------------------------------------------------------------------
// 非 data-sync：保留但不当作数据组
// ---------------------------------------------------------------------------

describe('collectDataGroupOverview 非 data-sync', () => {
  it('groupType 非 data-sync 的条目保留并标注，isDataSync=false', async () => {
    const fs = makeFakeFs({
      [config('admin', 'c.json')]: JSON.stringify({
        id: 'c',
        groupType: 'config-sync',
        name: 'Config Group',
        backends: [],
      }),
    });

    const overview = await collectDataGroupOverview(fs.promises);
    const entry = overview.apps[0].entries[0];

    expect(entry.parsed).toBe(true);
    expect(entry.problem).toBeNull();
    expect(entry.groupType).toBe('config-sync');
    expect(entry.isDataSync).toBe(false);
  });
});
