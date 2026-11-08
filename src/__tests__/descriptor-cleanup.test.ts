import { describe, it, expect, vi } from 'vitest';
import {
  dataGroupDescriptorPaths,
  deleteDataGroupDescriptor,
  type DescriptorCleanupRepo,
} from '../descriptor-cleanup';

/** 测试替身：只记录调用，不做任何解析（证明坏 JSON 也能按路径删除）。 */
function makeRepo(appId: string, opts: { failOn?: string } = {}): DescriptorCleanupRepo & {
  deleteFile: ReturnType<typeof vi.fn>;
  removeAppDataGroup: ReturnType<typeof vi.fn>;
} {
  const deleted: string[] = [];
  const deleteFile = vi.fn(async (path: string) => {
    if (opts.failOn === path) throw new Error('EPERM: 写入墓碑失败');
    deleted.push(path);
  });
  const removeAppDataGroup = vi.fn(async () => {});
  return { appId, deleteFile, removeAppDataGroup } as any;
}

describe('dataGroupDescriptorPaths', () => {
  it('同时给出 .config 与 legacy .meta 两份副本的仓库根路径', () => {
    expect(dataGroupDescriptorPaths('remotestorage-mvyglkn4', 'dir-struct-gen')).toEqual([
      '/.config/app-data-groups/remotestorage-mvyglkn4/dir-struct-gen.json',
      '/.meta/app-data-groups/remotestorage-mvyglkn4/dir-struct-gen.json',
    ]);
  });
});

describe('deleteDataGroupDescriptor', () => {
  it('跨 appId：按路径删除两份副本（走 deleteFile 的墓碑路径）', async () => {
    const repo = makeRepo('admin');
    const paths = await deleteDataGroupDescriptor(repo, 'remotestorage-mvyglkn4', 'dir-struct-gen');

    expect(repo.removeAppDataGroup).not.toHaveBeenCalled();
    expect(repo.deleteFile).toHaveBeenCalledTimes(2);
    expect(repo.deleteFile.mock.calls.map(c => c[0]).sort()).toEqual([...paths].sort());
    expect(paths).toEqual(dataGroupDescriptorPaths('remotestorage-mvyglkn4', 'dir-struct-gen'));
  });

  it('删除不依赖描述符内容，坏 JSON（解析失败）同样可删', async () => {
    // 替身里没有任何 readFile / JSON.parse：能完成删除即说明只看路径。
    const repo = makeRepo('admin');
    await expect(
      deleteDataGroupDescriptor(repo, 'remotestorage-mvyglkn4', 'dir-struct-gen'),
    ).resolves.toHaveLength(2);
  });

  it('本 appId：走库的正式删除 removeAppDataGroup（会 dispose 已激活句柄）', async () => {
    const repo = makeRepo('admin');
    await deleteDataGroupDescriptor(repo, 'admin', 'broken-group');

    expect(repo.removeAppDataGroup).toHaveBeenCalledWith('broken-group');
    expect(repo.deleteFile).not.toHaveBeenCalled();
  });

  it('某个副本删除失败时继续尝试另一份，并把失败路径抛给调用方', async () => {
    const repo = makeRepo('admin', { failOn: '/.config/app-data-groups/x/g.json' });
    await expect(deleteDataGroupDescriptor(repo, 'x', 'g')).rejects.toThrow(
      /\/\.config\/app-data-groups\/x\/g\.json（EPERM: 写入墓碑失败）/,
    );
    // 另一份仍然被处理过（部分成功不会静默）
    expect(repo.deleteFile.mock.calls.map(c => c[0])).toContain('/.meta/app-data-groups/x/g.json');
  });
});
