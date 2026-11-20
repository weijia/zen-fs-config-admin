import { describe, it, expect } from 'vitest';
import { groupCandidates } from '../components/IdentityCandidatesCard';

/**
 * 候选去重是界面层的最后一道防线：同一个值被多个根持有时只列一次，
 * 但要把「哪些根持有它」和根数量如实带出来，用户才看得出写入范围。
 */
describe('groupCandidates', () => {
  const a = 'c5b50d9d-0174-4599-ba20-239d32375de2';
  const b = 'd25103f3-cdd4-401c-8bba-aaf3aaa99318';

  it('同一值来自多个根时合并成一条，并累加根数', () => {
    const groups = groupCandidates([
      { source: 'remote', backendId: 'gitee', instanceId: a, rootCount: 1 },
      { source: 'remote', backendId: 'remote-storage', instanceId: a, rootCount: 1 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].instanceId).toBe(a);
    expect(groups[0].rootCount).toBe(2);
    expect(groups[0].sources).toEqual(['远端根 gitee', '远端根 remote-storage']);
  });

  it('不同值各自一条，UUID 不被截断', () => {
    const groups = groupCandidates([
      { source: 'local', instanceId: a, rootCount: 1 },
      { source: 'bootstrap', instanceId: b, rootCount: 1 },
    ]);
    expect(groups.map(g => g.instanceId)).toEqual([a, b]);
    expect(groups[0].sources).toEqual(['本机本地 .meta/group.json']);
    expect(groups[1].sources).toEqual(['配置组引导副本']);
  });

  it('跳过没有 instanceId 的脏候选', () => {
    const groups = groupCandidates([
      { source: 'remote', backendId: 'x', instanceId: '', rootCount: 1 },
    ]);
    expect(groups).toHaveLength(0);
  });
});
