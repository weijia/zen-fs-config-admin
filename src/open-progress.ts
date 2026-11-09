/**
 * 「打开同步组」的分阶段进度。
 *
 * 只用真实可观测的信号，不编造计数：
 *   · 实例创建流程（`RepoInstanceRegistry`）能明确报告「读取远端后端 / 连接配置仓 /
 *     首次同步 / 激活组」四个阶段的开始；
 *   · 首次同步期间 `repo.getSyncStatuses()` 提供每个同步对的 `state` 与 `lastResult`，
 *     据此可如实显示「已完成 k/n 个同步对」；zen-fs-sync 没有逐文件进度事件，
 *     所以这里也没有文件级百分比；
 *   · 组激活期间拿不到组句柄（库在 `init()` 完成后才缓存实例），因此只显示阶段。
 *
 * 纯函数 + 类型，供注册表、context 与 UI 复用。
 */
import type { SyncPairStatus } from 'zen-fs-config';

/** 打开流程的四个阶段（按时间顺序）。 */
export type OpenStage = 'prepare' | 'connect' | 'sync' | 'activate';

export const OPEN_STAGE_ORDER: OpenStage[] = ['prepare', 'connect', 'sync', 'activate'];

/** 阶段文案（顶栏 / 阶段列表共用）。 */
export const OPEN_STAGE_LABELS: Record<OpenStage, string> = {
  prepare: '准备打开',
  connect: '连接远端配置仓',
  sync: '首次同步配置仓',
  activate: '打开数据组',
};

/** 单个同步对的可展示状态（来自 `SyncPairStatus`）。 */
export interface OpenPairProgress {
  pairId: string;
  /** 冗余存储后端名，便于直接展示。 */
  name: string;
  /** `sync` / `watching` / `idle` / …（库的原始状态）。 */
  state: string;
  /** 该同步对至少完成过一次同步（`lastResult` 存在）。 */
  completed: boolean;
}

/** 注册表上报的进度更新（不含计时信息）。 */
export interface OpenProgressUpdate extends OpenProgressStage {
  appId: string;
}

/** 阶段 + 可展示细节（不含计时）。 */
export interface OpenProgressStage {
  stage: OpenStage;
  detail?: string;
  pairs: OpenPairProgress[];
}

/** context 对外的进度快照（补充本次打开的起始时间）。 */
export interface OpenProgress extends OpenProgressStage {
  startedAt: number;
  updatedAt: number;
}

/**
 * 把 repo 的同步对状态汇总成一句可读说明。
 *
 * `state === 'syncing'` 表示该对正在跑；`lastResult` 存在表示至少完成过一次。
 * 两者都来自库的 API，不涉及日志解析。
 */
export function summarizeSyncPairs(
  statuses: Map<string, SyncPairStatus>,
): { detail: string; pairs: OpenPairProgress[] } {
  const pairs: OpenPairProgress[] = Array.from(statuses.entries()).map(([pairId, status]) => ({
    pairId,
    name: status.targetName ?? status.pairId ?? pairId,
    state: String(status.state),
    completed: !!status.lastResult,
  }));

  const total = pairs.length;
  const done = pairs.filter(p => p.completed).length;
  if (total === 0) {
    return { detail: '等待同步对建立…', pairs };
  }

  const syncing = pairs.filter(p => p.state === 'syncing').map(p => p.name);
  if (syncing.length > 0) {
    const suffix = done > 0 ? `（已完成 ${done}/${total}）` : '';
    return { detail: `同步中：${syncing.join('、')}${suffix}`, pairs };
  }
  if (done < total) {
    return { detail: `已连接 ${done}/${total} 个同步对`, pairs };
  }
  return { detail: `已完成 ${done}/${total} 个后端，正在校验…`, pairs };
}

/** 阶段列表中的一行。 */
export interface OpenStageStep {
  stage: OpenStage;
  label: string;
  status: 'done' | 'active' | 'pending';
  detail?: string;
}

/** 由当前进度推导「已完成 / 进行中 / 未开始」的阶段列表。 */
export function progressSteps(progress: OpenProgress | null): OpenStageStep[] {
  if (!progress) return [];
  const current = OPEN_STAGE_ORDER.indexOf(progress.stage);
  return OPEN_STAGE_ORDER.map((stage, index) => ({
    stage,
    label: OPEN_STAGE_LABELS[stage],
    status: index < current ? 'done' : index === current ? 'active' : 'pending',
    detail: index === current ? progress.detail : undefined,
  }));
}
