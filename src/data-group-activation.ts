/**
 * 数据同步组「枚举 + 激活」的共享逻辑。
 *
 * 从 ConfigRepoContext 抽出来，供 admin 的 context 与多实例注册表复用，
 * 也避免纯逻辑模块反向依赖 React 组件文件。
 */
import type {
  AppDataGroup,
  AppDataBackendDescriptor,
  BackendSyncState,
  IConfigRepo,
} from 'zen-fs-config';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:data-groups');

/** 一个已激活的数据同步组在 UI 侧的视图。 */
export interface DataGroupInfo {
  /** 组 id（等于 `.config/app-data-groups/{appId}/{id}.json` 的文件名）。 */
  id: string;
  /** 用户可编辑的显示名（来自描述符）。 */
  name?: string;
  /** 组句柄；只在内部使用，UI 通过 context 字段与 helper 访问。 */
  group: AppDataGroup;
  /**
   * 组**声明**的后端（来自 `listDeclaredBackends()`，以组自己的权威定义为准）。
   * 与「已连接」不同：暂时不可达 / 配置有误的后端也会出现在这里。
   */
  backends: AppDataBackendDescriptor[];
  /**
   * 每个声明后端的连通状态。没有 `error` 且有 `pairId` 的条目表示已建立同步对；
   * 带 `error` 的表示声明了但未连上（UI 据此标注）。
   */
  backendStates: BackendSyncState[];
  /** 激活 / 同步过程中的错误（若有）。 */
  error?: string;
}

/**
 * 激活单个数据同步组。
 *
 * `repo.getAppDataGroup(id)` 会实例化 `AppDataGroupImpl` 并触发 `init()`
 * （建本地主副本 → 为每个后端建双向 SyncPair → syncAll → watchAll），
 * 因此调用它即完成「自动同步」。repo 内部按 id 缓存实例，重复调用不会
 * 产生重复 SyncPair。
 */
export async function activateDataGroup(
  repo: IConfigRepo,
  id: string,
  descriptor?: import('zen-fs-config').AppDataGroupDescriptor,
): Promise<DataGroupInfo> {
  try {
    const group = await repo.getAppDataGroup(id);
    const backends = group.listDeclaredBackends();
    const backendStates = Array.from(group.getBackendSyncStates().values());
    const connected = backendStates.filter(s => s.pairId && !s.error).length;
    log.log(`[data-groups] activated "${id}" (${backends.length} declared, ${connected} connected)`);
    return { id, name: descriptor?.name, group, backends, backendStates };
  } catch (err: any) {
    log.error(`[data-groups] failed to activate "${id}":`, err?.message ?? err);
    return {
      id,
      name: descriptor?.name,
      group: null as unknown as AppDataGroup,
      backends: descriptor?.backends ?? [],
      backendStates: [],
      error: err?.message ?? String(err),
    };
  }
}

/**
 * 枚举并激活某个 repo 下的数据同步组。
 *
 * @param onlyGroupId 只激活这一个组（顶栏选中即打开时用，避免一次拉起该
 *   appId 的全部组）；`null` 表示不激活任何数据组（打开的是配置组）；
 *   缺省时激活全部（admin 启动沿用旧行为）。
 *
 * 单个组失败只记录错误，不影响其它组，也不影响配置仓连接。
 */
export async function activateDataGroups(
  repo: IConfigRepo,
  onlyGroupId?: string | null,
): Promise<DataGroupInfo[]> {
  if (onlyGroupId === null) return [];

  let descriptors: import('zen-fs-config').AppDataGroupDescriptor[];
  try {
    descriptors = await repo.listAppDataGroups();
  } catch (err: any) {
    log.warn('[data-groups] listAppDataGroups failed:', err?.message ?? err);
    if (onlyGroupId) return [await activateDataGroup(repo, onlyGroupId)];
    return [];
  }

  if (onlyGroupId) {
    const desc = descriptors.find(d => d.id === onlyGroupId);
    return [await activateDataGroup(repo, onlyGroupId, desc)];
  }

  const infos: DataGroupInfo[] = [];
  for (const desc of descriptors) {
    infos.push(await activateDataGroup(repo, desc.id, desc));
  }
  return infos;
}

/** 释放一组激活过的数据组句柄（幂等）。 */
export async function disposeDataGroups(infos: DataGroupInfo[]): Promise<void> {
  for (const info of infos) {
    try {
      await info.group?.dispose?.();
    } catch {
      /* already disposed */
    }
  }
}
