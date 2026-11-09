/**
 * 多 appId 配置仓实例注册表（懒创建）。
 *
 * 设计目标：
 *   · `admin` 实例由 ConfigRepoContext 在启动时创建，注册表不管理它；
 *   · 其它 appId 只有在用户点击「管理（读写）」时才创建实例；
 *   · 每个实例用自己 appId 的本地主存储（createConfigRepo 内部按
 *     `zen-fs-config-config-{appId}` 派生），并连接与 admin 相同的远端
 *     配置仓，从而同步到该 appId 的组描述符与后端配置；
 *   · 并发实例数有上限（默认 3），超出时明确提示先释放；
 *   · 释放必须先 flush，再断开，避免未落盘改动丢失；
 *   · 组管理写操作一律走该实例的 repo / group API，不直接写 fs。
 */
import type { IConfigRepo } from 'zen-fs-config';
import {
  activateDataGroup,
  activateDataGroups,
  disposeDataGroups,
  type DataGroupInfo,
} from './data-group-activation';
import { summarizeSyncPairs, type OpenProgressUpdate } from './open-progress';

/** 默认允许同时存在的懒创建实例数上限。 */
export const DEFAULT_MAX_INSTANCES = 3;

/** admin 的远端配置仓后端信息，用于新实例连接同一远端。 */
export interface RemoteBackendInfo {
  id: string;
  type: string;
  options: Record<string, unknown>;
}

/**
 * admin 远端后端查询结果：
 *   · `ok`       取到了可用的远端副本后端；
 *   · `not-ready` admin 配置仓尚未就绪（冷启动 / 重连中），稍后重试即可；
 *   · `none`      admin 已就绪但确实没有配置远端副本后端。
 *
 * `not-ready` 与 `none` 必须分开，否则会给用户看到
 * 「请先在 Backends 页为 admin 配置远端后端」这类误导性提示。
 */
export type RemoteBackendLookup =
  | { status: 'ok'; backend: RemoteBackendInfo }
  | { status: 'not-ready' }
  | { status: 'none' };

/** 一个已创建的 appId 实例。 */
export interface RepoInstance {
  appId: string;
  repo: IConfigRepo;
  groups: DataGroupInfo[];
  /** 该实例连接所用的远端后端 id。 */
  backendId: string;
  /** 创建时间（ms）。 */
  createdAt: number;
}

/** 实例的运行状态快照（用于 UI 展示）。 */
export interface RepoInstanceStatus {
  /** 已加载的组数量（含激活失败的组）。 */
  groupCount: number;
  /** 成功激活的组数量。 */
  activeGroupCount: number;
  /** 同步对数量。 */
  pairCount: number;
  /** 正在 watch 的同步对数量；> 0 表示「在同步」。 */
  watchingCount: number;
}

export interface RepoInstanceRegistryOptions {
  /** 用给定 appId + 远端后端创建 repo（生产实现包 createConfigRepo）。 */
  createRepo: (appId: string, backend: RemoteBackendInfo) => Promise<IConfigRepo>;
  /**
   * 读取 admin 的远端后端。
   * 未就绪返回 `not-ready`（可重试），确实没有远端后端返回 `none`。
   */
  getRemoteBackend: () => Promise<RemoteBackendLookup>;
  /**
   * 打开过程的分阶段进度（可选）。
   *
   * 只在能拿到真实信号时上报：阶段切换、以及首次同步期间按 repo 的同步对
   * 状态汇总的计数（库没有逐文件进度）。回调抛错不影响打开流程。
   */
  onProgress?: (update: OpenProgressUpdate) => void;
  /** 并发实例上限，默认 3。 */
  maxInstances?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 检查 repo 的后端连接 / 首次同步结果，把静默失败转成可读错误。 */
function assertRepoHealthy(repo: IConfigRepo): void {
  const backendStates = repo.getBackendSyncStates?.() ?? new Map();
  for (const state of backendStates.values()) {
    if (state.error) {
      // zen-fs-config >= 0.6.1 records real sync:error messages here
      // (401/403/404/timeout); older versions only record connect failures.
      throw new Error(`远端后端「${state.backendId}」同步失败：${state.error.message}`);
    }
  }

  // syncAll() 会吞掉单个同步对的异常；成功同步一定会写入 lastResult。
  // 没有 error 又没有 lastResult 时，只能说明首次同步尚未完成（可能仍在
  // 进行中），不能断言凭据无效。
  const statuses = repo.getSyncStatuses?.() ?? new Map();
  for (const status of statuses.values()) {
    if (!status.lastResult) {
      throw new Error(
        `同步「${status.targetName ?? status.pairId}」首次同步尚未完成，请稍后重试`,
      );
    }
  }
}

export class RepoInstanceRegistry {
  private readonly instances = new Map<string, RepoInstance>();
  /** 同一 appId 的创建请求合并，保证「懒创建只建一次」。 */
  private readonly pending = new Map<string, Promise<RepoInstance>>();
  private readonly options: RepoInstanceRegistryOptions;
  private readonly maxInstances: number;

  constructor(options: RepoInstanceRegistryOptions) {
    this.options = options;
    this.maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
  }

  /** 上报进度；进度回调的错误不能影响打开流程本身。 */
  private report(update: OpenProgressUpdate): void {
    try {
      this.options.onProgress?.(update);
    } catch {
      /* ignore progress callback failures */
    }
  }

  /** 已创建实例数。 */
  get size(): number {
    return this.instances.size;
  }

  /** 实例是否已创建。 */
  has(appId: string): boolean {
    return this.instances.has(appId);
  }

  /** 取实例（未创建时返回 undefined）。 */
  get(appId: string): RepoInstance | undefined {
    return this.instances.get(appId);
  }

  /** 当前所有实例的快照。 */
  list(): RepoInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * 懒创建（幂等）：已存在直接返回；并发调用只会真正创建一次。
   *
   * @param onlyGroupId 只激活该数据组；`null` 不激活任何数据组（打开配置组）；
   *   缺省时激活该 appId 的全部数据组。
   */
  async create(appId: string, onlyGroupId?: string | null): Promise<RepoInstance> {
    if (appId === 'admin') {
      throw new Error('admin 实例由 ConfigRepoContext 管理，不能通过注册表创建');
    }

    const existing = this.instances.get(appId);
    if (existing) return existing;

    // 同一 appId 的创建请求合并（不同组的并发请求也只会建一个 repo）。
    const inFlight = this.pending.get(appId);
    if (inFlight) return inFlight;

    const task = this.doCreate(appId, onlyGroupId).finally(() => {
      this.pending.delete(appId);
    });
    this.pending.set(appId, task);
    return task;
  }

  private async doCreate(appId: string, onlyGroupId?: string | null): Promise<RepoInstance> {
    if (appId === 'admin') throw new Error('admin 实例不由注册表管理');

    if (this.instances.size >= this.maxInstances) {
      const active = Array.from(this.instances.keys()).join('、');
      throw new Error(
        `实例数量已达上限（${this.maxInstances}），请先释放一个实例：${active || '（无）'}`,
      );
    }

    let lookup: RemoteBackendLookup;
    this.report({
      appId,
      stage: 'prepare',
      detail: `appId「${appId}」`,
      pairs: [],
    });
    try {
      lookup = await this.options.getRemoteBackend();
    } catch (err) {
      throw new Error(`实例创建失败：读取 admin 远端后端配置失败：${messageOf(err)}`);
    }
    if (lookup.status === 'not-ready') {
      throw new Error(
        `实例创建失败：admin 配置仓尚未就绪，暂时无法为 appId「${appId}」加载组描述符，请稍后重试。`,
      );
    }
    if (lookup.status === 'none') {
      throw new Error(
        `实例创建失败：admin 没有可用的远端配置后端，无法为 appId「${appId}」加载组描述符。` +
        '请先在 Backends 页为 admin 配置远端后端。',
      );
    }
    const backend = lookup.backend;

    this.report({
      appId,
      stage: 'connect',
      detail: `后端 ${backend.id}（${backend.type}）`,
      pairs: [],
    });
    let repo: IConfigRepo;
    try {
      repo = await this.options.createRepo(appId, backend);
    } catch (err) {
      throw new Error(`实例创建失败：appId「${appId}」的配置仓无法连接：${messageOf(err)}`);
    }

    let progressTimer: ReturnType<typeof setInterval> | undefined;
    try {
      // 首次同步：库没有逐文件进度，只能按同步对的 state / lastResult 如实汇总。
      const readPairs = () => summarizeSyncPairs(repo.getSyncStatuses?.() ?? new Map());
      this.report({ appId, stage: 'sync', ...readPairs() });
      progressTimer = setInterval(() => {
        try {
          this.report({ appId, stage: 'sync', ...readPairs() });
        } catch {
          /* repo 已 dispose 时忽略 */
        }
      }, 500);

      // 等待首次同步完成，确保远端该 appId 的描述符已落到本地。
      await repo.flush();
      assertRepoHealthy(repo);
      this.report({
        appId,
        stage: 'activate',
        detail: onlyGroupId ? `组「${onlyGroupId}」` : '数据组',
        pairs: [],
      });
      const groups = await activateDataGroups(repo, onlyGroupId);
      const instance: RepoInstance = {
        appId,
        repo,
        groups,
        backendId: backend.id,
        createdAt: Date.now(),
      };
      this.instances.set(appId, instance);
      // 自愈：旧版本 / 竞态可能让配置组副本落后于组内声明，以组内为准重写副本。
      for (const info of groups) {
        if (info.group && !info.error) await this.syncDescriptorCopy(instance, info.id, true);
      }
      return instance;
    } catch (err) {
      try {
        await repo.dispose();
      } catch {
        /* best effort */
      }
      throw new Error(`实例创建失败：appId「${appId}」：${messageOf(err)}`);
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  /**
   * 释放实例：先 flush（失败则保留实例并抛错，避免丢数据），
   * 再停 watcher / 同步循环（repo.dispose），最后从注册表移除。
   */
  async release(appId: string): Promise<boolean> {
    const instance = this.instances.get(appId);
    if (!instance) return false;

    try {
      await instance.repo.flush();
    } catch (err) {
      throw new Error(`释放失败：appId「${appId}」的 flush 未成功，实例已保留：${messageOf(err)}`);
    }

    try {
      await disposeDataGroups(instance.groups);
      await instance.repo.dispose();
    } finally {
      this.instances.delete(appId);
    }
    return true;
  }

  /**
   * 重新读取该实例已激活组的状态与名字（不激活新组）。
   * 组增删后通过 `listAppDataGroups()` 校正，但不会波及未选中的组。
   */
  async refresh(appId: string): Promise<void> {
    const instance = this.require(appId);
    let descriptors: import('zen-fs-config').AppDataGroupDescriptor[] = [];
    try {
      descriptors = await instance.repo.listAppDataGroups();
    } catch {
      /* 描述符暂时读不到时保留现有快照 */
    }
    const ids = new Set(descriptors.map(d => d.id));
    instance.groups = instance.groups
      .filter(info => ids.size === 0 || ids.has(info.id))
      .map(info => {
        if (!info.group) return { ...info, name: descriptors.find(d => d.id === info.id)?.name ?? info.name };
        return {
          ...info,
          name: descriptors.find(d => d.id === info.id)?.name ?? info.name,
          backends: info.group.listDeclaredBackends(),
          backendStates: Array.from(info.group.getBackendSyncStates().values()),
          error: undefined,
        };
      });
  }

  /**
   * 在已创建的实例上激活单个数据组（同一 appId 切换组时用）。
   * 已激活时直接返回现有快照。
   */
  async activateGroup(appId: string, groupId: string): Promise<DataGroupInfo> {
    const instance = this.require(appId);
    const existing = instance.groups.find(g => g.id === groupId && g.group);
    if (existing) return existing;
    const info = await activateDataGroup(instance.repo, groupId);
    const idx = instance.groups.findIndex(g => g.id === groupId);
    instance.groups = idx >= 0
      ? instance.groups.map((g, i) => (i === idx ? info : g))
      : [...instance.groups, info];
    if (info.group && !info.error) await this.syncDescriptorCopy(instance, groupId, true);
    return info;
  }

  /** 改名。 */
  async renameGroup(appId: string, groupId: string, name: string): Promise<void> {
    const instance = this.require(appId);
    await instance.repo.updateAppDataGroupName(groupId, name);
    await this.refresh(appId);
  }

  /** 替换组内某个后端的参数（保留 backendId）。 */
  async replaceBackend(
    appId: string,
    groupId: string,
    backendId: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<void> {
    const instance = this.require(appId);
    // replaceAppDataGroupBackend 会 dispose 旧组并返回新组；必须先把快照
    // 换成新句柄，再 refresh（refresh 只读 instance.groups 里的句柄）。
    const group = await instance.repo.replaceAppDataGroupBackend(groupId, backendId, type, options, description);
    instance.groups = instance.groups.map(info => info.id === groupId
      ? {
          ...info,
          group,
          backends: group.listDeclaredBackends(),
          backendStates: Array.from(group.getBackendSyncStates().values()),
          error: undefined,
        }
      : info);
    await this.refresh(appId);
    await this.syncDescriptorCopy(instance, groupId);
  }

  /** 给组内新增后端（走该实例中该组的 group API）。 */
  async addBackend(
    appId: string,
    groupId: string,
    backendId: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<void> {
    const group = this.requireGroup(appId, groupId);
    await group.addBackend(backendId, type, options, description);
    await this.refresh(appId);
    await this.syncDescriptorCopy(this.require(appId), groupId);
  }

  /** 从组内删除后端。 */
  async removeBackend(appId: string, groupId: string, backendId: string): Promise<void> {
    const group = this.requireGroup(appId, groupId);
    await group.removeBackend(backendId);
    await this.refresh(appId);
    await this.syncDescriptorCopy(this.require(appId), groupId);
  }

  /** 删除数据组。 */
  async removeGroup(appId: string, groupId: string): Promise<void> {
    const instance = this.require(appId);
    await instance.repo.removeAppDataGroup(groupId);
    await this.refresh(appId);
  }

  /** 手动 flush 某实例。 */
  async flush(appId: string): Promise<void> {
    const instance = this.require(appId);
    await instance.repo.flush();
  }

  /** 状态快照；未创建时返回 null。 */
  status(appId: string): RepoInstanceStatus | null {
    const instance = this.instances.get(appId);
    if (!instance) return null;
    const statuses = instance.repo.getSyncStatuses?.() ?? new Map();
    const watchingCount = Array.from(statuses.values()).filter(s => s.watching).length;
    return {
      groupCount: instance.groups.length,
      activeGroupCount: instance.groups.filter(g => !g.error).length,
      pairCount: statuses.size,
      watchingCount,
    };
  }

  /** 组件卸载 / 页面离开时的尽力清理（先 flush，失败忽略）。 */
  async disposeAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      try {
        await instance.repo.flush();
      } catch {
        /* best effort */
      }
      try {
        await disposeDataGroups(instance.groups);
        await instance.repo.dispose();
      } catch {
        /* best effort */
      }
    }
    this.instances.clear();
  }

  /**
   * 把组内权威后端列表写回配置组副本
   * （`.config/app-data-groups/{appId}/{id}.json`）。
   *
   * · 只取组句柄的 `listDeclaredBackends()`，绝不把副本并入组内；
   * · 库的写入按字节幂等：内容相同则零写入；
   * · `heal` 为 true 时先比对后端 id 集合，不一致才重写并打一条 warning，
   *   用于「组内非空、副本为空/落后」这类历史不一致；
   * · 刷新失败只记 warning，不影响组内的写操作结果。
   */
  private async syncDescriptorCopy(
    instance: RepoInstance,
    groupId: string,
    heal = false,
  ): Promise<void> {
    const group = instance.groups.find(g => g.id === groupId)?.group;
    if (!group) return;
    // 该 API 在 0.7.2 的 class 上是公开方法，但尚未进入 IConfigRepo 接口；
    // 用结构化类型探测，老版本缺这个方法时跳过（组内写操作本身仍然成功）。
    const writer = instance.repo as unknown as {
      updateAppDataGroupDescriptor?: (
        id: string,
        backends: import('zen-fs-config').AppDataBackendDescriptor[],
      ) => Promise<void>;
    };
    if (typeof writer.updateAppDataGroupDescriptor !== 'function') return;
    try {
      const authoritative = group.listDeclaredBackends();
      if (heal) {
        const descriptor = (await instance.repo.listAppDataGroups()).find(d => d.id === groupId);
        const copyIds = (descriptor?.backends ?? []).map(b => b.id).sort().join(',');
        const liveIds = authoritative.map(b => b.id).sort().join(',');
        if (copyIds === liveIds) return;
        console.warn(
          `[repo-instances] 数据组「${groupId}」的配置组副本与组内声明不一致：` +
          `副本 [${copyIds || '空'}]，组内 [${liveIds || '空'}]，已按组内重写副本。`,
        );
      }
      // meta 省略 → 库保留副本里已有的 name / features。
      await writer.updateAppDataGroupDescriptor.call(instance.repo, groupId, authoritative);
    } catch (err) {
      console.warn(
        `[repo-instances] 数据组「${groupId}」的配置组副本刷新失败：${messageOf(err)}`,
      );
    }
  }

  private require(appId: string): RepoInstance {
    const instance = this.instances.get(appId);
    if (!instance) {
      throw new Error(`实例「${appId}」尚未打开，请先在顶栏同步组选择器中选择该组。`);
    }
    return instance;
  }

  private requireGroup(appId: string, groupId: string): import('zen-fs-config').AppDataGroup {
    const instance = this.require(appId);
    const info = instance.groups.find(g => g.id === groupId);
    if (!info?.group) {
      throw new Error(`数据组「${groupId}」未激活，无法修改后端`);
    }
    return info.group;
  }
}
