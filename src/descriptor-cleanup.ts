/**
 * 删除数据组描述符（用于「描述符损坏、无法打开」的组登记）。
 *
 * 只删组登记，不动数据：配置仓内有两份描述符副本，两份都要清
 *   · `.config/app-data-groups/{appId}/{id}.json`（新布局，总览优先读取）
 *   · `.meta/app-data-groups/{appId}/{id}.json`（legacy 镜像）
 *
 * 按**路径**删除，不依赖 JSON 能否解析——坏 JSON（例如被截断的
 * `Unexpected end of JSON input`）同样可删。
 *
 * 删除走 ConfigRepo 的正式删除路径（`deleteFile` / `removeAppDataGroup`），
 * 因此会写入墓碑；随后由调用方 flush，墓碑才会同步到远端副本，
 * 淘汰远端的坏 JSON，避免下一轮同步把它重新拉回本地。
 *
 * 注意：数据组自己的权威后端清单在组内 fs 的 `.meta/backends/`（随数据组
 * 同步），不在配置仓内；这里只删配置仓的组登记，不会碰组内用户数据。
 */
import { APP_DATA_GROUPS_DIR, LEGACY_APP_DATA_GROUPS_DIR } from './data-group-overview';

/** 需要清理的两份描述符副本（仓库根 fs 的绝对路径）。 */
export function dataGroupDescriptorPaths(appId: string, groupId: string): string[] {
  return [
    `${APP_DATA_GROUPS_DIR}/${appId}/${groupId}.json`,
    `${LEGACY_APP_DATA_GROUPS_DIR}/${appId}/${groupId}.json`,
  ];
}

/** 删除描述符所需的最小仓库能力（便于测试替身）。 */
export interface DescriptorCleanupRepo {
  readonly appId: string;
  deleteFile(path: string): Promise<void>;
  removeAppDataGroup(id: string): Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 删除某个 appId 下某个数据组的登记（两份描述符副本）。
 *
 * @returns 实际尝试删除的路径（便于日志 / 测试断言）。
 */
export async function deleteDataGroupDescriptor(
  repo: DescriptorCleanupRepo,
  appId: string,
  groupId: string,
): Promise<string[]> {
  const paths = dataGroupDescriptorPaths(appId, groupId);

  if (appId === repo.appId) {
    // 本 appId 的组可能有已激活句柄（正常描述符改坏的情况），走库的正式
    // 删除：先 dispose 组，再对两个路径写墓碑。
    await repo.removeAppDataGroup(groupId);
    return paths;
  }

  // 跨 appId：admin 的 repo 只按自己的 appId 定位描述符，这里按路径删除。
  const failed: string[] = [];
  for (const path of paths) {
    try {
      await repo.deleteFile(path);
    } catch (err) {
      failed.push(`${path}（${messageOf(err)}）`);
    }
  }
  if (failed.length > 0) {
    throw new Error(`删除描述符失败：${failed.join('；')}`);
  }
  return paths;
}
