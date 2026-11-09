import { describe, it, expect } from 'vitest';
import {
  OPEN_STAGE_LABELS,
  progressSteps,
  summarizeSyncPairs,
  type OpenProgress,
} from '../open-progress';

/** 构造一个同步对状态；只填库实际提供的字段。 */
function pair(id: string, extra: Record<string, unknown> = {}): [string, any] {
  return [id, {
    pairId: id,
    targetName: id,
    state: 'watching',
    lastResult: {},
    ...extra,
  }];
}

describe('summarizeSyncPairs', () => {
  it('没有同步对时只提示等待，不编造计数', () => {
    expect(summarizeSyncPairs(new Map())).toEqual({
      detail: '等待同步对建立…',
      pairs: [],
    });
  });

  it('同步中时列出后端名，并附带已完成计数', () => {
    const statuses = new Map([
      pair('a', { state: 'syncing', lastResult: undefined }),
      pair('b'),
    ]);

    const result = summarizeSyncPairs(statuses);
    expect(result.detail).toBe('同步中：a（已完成 1/2）');
    expect(result.pairs.map(p => [p.name, p.completed])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('未全部完成时给出「已完成/总数」，不宣称已完成', () => {
    const statuses = new Map([
      pair('a', { lastResult: undefined }),
      pair('b'),
    ]);
    expect(summarizeSyncPairs(statuses).detail).toBe('已连接 1/2 个同步对');
  });

  it('全部完成时说明正在校验', () => {
    const statuses = new Map([pair('a'), pair('b')]);
    expect(summarizeSyncPairs(statuses).detail).toBe('已完成 2/2 个后端，正在校验…');
  });
});

describe('progressSteps', () => {
  it('没有进度时没有步骤', () => {
    expect(progressSteps(null)).toEqual([]);
  });

  it('当前阶段之前的为 done、之后为 pending，detail 只挂在当前阶段', () => {
    const progress: OpenProgress = {
      stage: 'sync',
      detail: '同步中：a',
      pairs: [],
      startedAt: 0,
      updatedAt: 0,
    };

    const steps = progressSteps(progress);
    expect(steps.map(s => s.status)).toEqual(['done', 'done', 'active', 'pending']);
    expect(steps[2]).toMatchObject({
      stage: 'sync',
      label: OPEN_STAGE_LABELS.sync,
      detail: '同步中：a',
    });
    expect(steps.filter(s => s.detail).length).toBe(1);
  });
});
