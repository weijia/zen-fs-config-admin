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
  activateDataGroups,
  disposeDataGroups,
  type DataGroupInfo,
} from './data-group-activation';

/** 默认允许同时存在的懒创建实例数上限。 */
export const DEFAULT_MAX_INSTANCES = 3;

/** admin 的远端配置仓后端信息，用于新实例连接同一远端。 */
export interface RemoteBackendInfo {
  id: string;
  type: string;
  options: Record<string, unknown>;
}

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
  /** 读取 admin 的远端后端；返回 null 时实例创建会给出明确错误。 */
  getRemoteBackend: () => Promise<RemoteBackendInfo | null>;
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
      throw new Error(`远端后端「${state.backendId}」连接失败：${state.error.message}`);
    }
  }

  // syncAll() 会吞掉单个同步对的异常；成功同步一定会写入 lastResult。
  // flush 之后仍没有 lastResult 的对，视为首次同步未完成（远端不可达 / 凭据无效）。
  const statuses = repo.getSyncStatuses?.() ?? new Map();
  for (const status of statuses.values()) {
    if (!status.lastResult) {
      throw new Error(
        `同步「${status.targetName ?? status.pairId}」未成功完成：远端可能不可达或凭据无效`,
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
   */
  async create(appId: string): Promise<RepoInstance> {
    if (appId === 'admin') {
      throw new Error('admin 实例由 ConfigRepoContext 管理，不能通过注册表创建');
    }

    const existing = this.instances.get(appId);
    if (existing) return existing;

    const inFlight = this.pending.get(appId);
    if (inFlight) return inFlight;

    const task = this.doCreate(appId).finally(() => {
      this.pending.delete(appId);
    });
    this.pending.set(appId, task);
    return task;
  }

  private async doCreate(appId: string): Promise<RepoInstance> {
    if (appId === 'admin') throw new Error('admin 实例不由注册表管理');

    if (this.instances.size >= this.maxInstances) {
      const active = Array.from(this.instances.keys()).join('、');
      throw new Error(
        `实例数量已达上限（${this.maxInstances}），请先释放一个实例：${active || '（无）'}`,
      );
    }

    let backend: RemoteBackendInfo | null;
    try {
      backend = await this.options.getRemoteBackend();
    } catch (err) {
      throw new Error(`实例创建失败：读取 admin 远端后端配置失败：${messageOf(err)}`);
    }
    if (!backend) {
      throw new Error(
        `实例创建失败：admin 没有可用的远端配置后端，无法为 appId「${appId}」加载组描述符。` +
        '请先在 Backends 页为 admin 配置远端后端。',
      );
    }

    let repo: IConfigRepo;
    try {
      repo = await this.options.createRepo(appId, backend);
    } catch (err) {
      throw new Error(`实例创建失败：appId「${appId}」的配置仓无法连接：${messageOf(err)}`);
    }

    try {
      // 等待首次同步完成，确保远端该 appId 的描述符已落到本地。
      await repo.flush();
      assertRepoHealthy(repo);
      const groups = await activateDataGroups(repo);
      const instance: RepoInstance = {
        appId,
        repo,
        groups,
        backendId: backend.id,
        createdAt: Date.now(),
      };
      this.instances.set(appId, instance);
      return instance;
    } catch (err) {
      try {
        await repo.dispose();
      } catch {
        /* best effort */
      }
      throw new Error(`实例创建失败：appId「${appId}」：${messageOf(err)}`);
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

  /** 重新枚举该实例的组（增删改后调用）。 */
  async refresh(appId: string): Promise<void> {
    const instance = this.require(appId);
    instance.groups = await activateDataGroups(instance.repo);
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
    await instance.repo.replaceAppDataGroupBackend(groupId, backendId, type, options, description);
    await this.refresh(appId);
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
  }

  /** 从组内删除后端。 */
  async removeBackend(appId: string, groupId: string, backendId: string): Promise<void> {
    const group = this.requireGroup(appId, groupId);
    await group.removeBackend(backendId);
    await this.refresh(appId);
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

  private require(appId: string): RepoInstance {
    const instance = this.instances.get(appId);
    if (!instance) {
      throw new Error(`实例「${appId}」尚未创建，请先在 Files 页点击「管理（读写）」创建。`);
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
