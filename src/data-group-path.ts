/**
 * 数据组路径约定（FilesPage 与测试共用）
 *
 * 文件树的根同时承载两类内容：
 *   · 配置仓（config-sync）真实路径            → `/admin/foo.json`
 *   · 数据同步组（data-sync）                  → `/@dg/<groupId>/<组内路径>`
 *
 * `/@dg` 是保留前缀（真实配置仓里不会出现），用它把「作用域 + 组内路径」
 * 编码进同一个 path 字符串，从而复用现有的 URL 路由（`/files/*`）与选中态。
 *
 * 单独成文件的原因：这些是纯函数常量，放在页面组件文件里会触发
 * `react(only-export-components)` 警告（组件文件应只导出组件）。
 */

const DATA_GROUP_PREFIX = '@dg';
const DATA_GROUP_ROOT = `/${DATA_GROUP_PREFIX}`;

/** 路径是否属于数据组作用域。 */
export function isDataGroupPath(path: string): boolean {
  return path === DATA_GROUP_ROOT || path.startsWith(`${DATA_GROUP_ROOT}/`);
}

/** 拼出数据组作用域下的树路径。 */
export function makeDataGroupPath(groupId: string, innerPath: string): string {
  const inner = !innerPath || innerPath === '/'
    ? ''
    : innerPath.startsWith('/')
      ? innerPath
      : `/${innerPath}`;
  return `${DATA_GROUP_ROOT}/${groupId}${inner}`;
}

/** 解析树路径 → 组 id + 组内路径；非数据组路径返回 null。 */
export function parseDataGroupPath(path: string): { groupId: string; inner: string } | null {
  if (!isDataGroupPath(path)) return null;
  const rest = path.slice(DATA_GROUP_ROOT.length); // '' 或 '/gid/...'
  if (!rest) return { groupId: '', inner: '/' };
  const parts = rest.split('/').filter(Boolean);
  const groupId = parts[0] ?? '';
  const inner = parts.length > 1 ? `/${parts.slice(1).join('/')}` : '/';
  return { groupId, inner };
}

/** 树路径 → 实际传给 fs 的路径（数据组需去掉 `/@dg/<gid>` 前缀）。 */
export function fsPathFor(path: string): string {
  return parseDataGroupPath(path)?.inner ?? path;
}

/** 数据组容器节点的树路径（如 `/@dg`）。 */
export const DATA_GROUPS_ROOT_PATH = DATA_GROUP_ROOT;
