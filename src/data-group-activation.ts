/**
 * 数据同步组「枚举 + 激活」的共享逻辑。
 *
 * 从 ConfigRepoContext 抽出来，供 admin 的 context 与多实例注册表复用，
 * 也避免纯逻辑模块反向依赖 React 组件文件。
 */
import type { IConfigRepo } from 'zen-fs-config';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:data-groups');

/** 一个已激活的数据同步组在 UI 侧的视图。 */
export interface DataGroupInfo {
  /** 组 id（等于 `.config/app-data-groups/{appId}/{id}.json` 的文件名）。 */
  id: string;
  /** 用户可编辑的显示名（来自描述符）。 */
  name?: string;
  /** 组句柄；只在内部使用，UI 通过 context 字段与 helper 访问。 */
  group: import('zen-fs-config').AppDataGroup;
  /** 组内后端描述符。 */
  backends: import('zen-fs-config').AppDataBackendDescriptor[];
  /** 激活 / 同步过程中的错误（若有）。 */
  error?: string;
}

/**
 * 枚举并激活某个 repo 下当前 appId 的全部数据同步组。
 *
 * `repo.getAppDataGroup(id)` 会实例化 `AppDataGroupImpl` 并触发 `init()`
 * （建本地主副本 → 为每个后端建双向 SyncPair → syncAll → watchAll），
 * 因此调用它即完成「自动同步」。repo 内部按 id 缓存实例，重复调用不会
 * 产生重复 SyncPair。
 *
 * 单个组失败只记录错误，不影响其它组，也不影响配置仓连接。
 */
export async function activateDataGroups(repo: IConfigRepo): Promise<DataGroupInfo[]> {
  let descriptors: import('zen-fs-config').AppDataGroupDescriptor[];
  try {
    descriptors = await repo.listAppDataGroups();
  } catch (err: any) {
    log.warn('[data-groups] listAppDataGroups failed:', err?.message ?? err);
    return [];
  }

  const infos: DataGroupInfo[] = [];
  for (const desc of descriptors) {
    try {
      const group = await repo.getAppDataGroup(desc.id);
      infos.push({ id: desc.id, name: desc.name, group, backends: group.listBackends?.() ?? desc.backends ?? [] });
      log.log(`[data-groups] activated "${desc.id}" (${(desc.backends ?? []).length} backend(s))`);
    } catch (err: any) {
      log.error(`[data-groups] failed to activate "${desc.id}":`, err?.message ?? err);
      infos.push({
        id: desc.id,
        name: desc.name,
        group: null as unknown as import('zen-fs-config').AppDataGroup,
        backends: desc.backends ?? [],
        error: err?.message ?? String(err),
      });
    }
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
