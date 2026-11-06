/**
 * 数据组路径约定（FilesPage 与测试共用）
 *
 * 文件树的根同时承载两类内容：
 *   · 配置仓（config-sync）真实路径                  → `/admin/foo.json`
 *   · admin 自己的数据同步组（data-sync，历史形式）    → `/@dg/<groupId>/<组内路径>`
 *   · 其它 appId 的数据同步组（独立实例）             → `/@adg/<appId>/<groupId>/<组内路径>`
 *
 * `/@dg` / `/@adg` 是保留前缀（真实配置仓里不会出现），用它把
 * 「appId + 组 + 组内路径」编码进同一个 path 字符串，从而复用现有的
 * URL 路由（`/files/*`）与选中态。
 *
 * 两种前缀的原因：`/@dg/<groupId>` 是 admin 的历史 URL 形式，保持不改；
 * 其它 appId 需要带 appId 才能无歧义地解析（不同 appId 的 groupId 可能重名）。
 *
 * 单独成文件的原因：这些是纯函数常量，放在页面组件文件里会触发
 * `react(only-export-components)` 警告（组件文件应只导出组件）。
 */

const DATA_GROUP_PREFIX = '@dg';
const APP_DATA_GROUP_PREFIX = '@adg';
const DATA_GROUP_ROOT = `/${DATA_GROUP_PREFIX}`;
const APP_DATA_GROUP_ROOT = `/${APP_DATA_GROUP_PREFIX}`;

/** 历史 `/@dg` 形式所属的 appId（admin 自管理实例）。 */
export const DEFAULT_DATA_GROUP_APP_ID = 'admin';

/** 数据组作用域：appId + 组 id + 组内路径。 */
export interface DataGroupScope {
  appId: string;
  groupId: string;
  inner: string;
}

/** 路径是否属于数据组作用域（两种前缀都算）。 */
export function isDataGroupPath(path: string): boolean {
  return (
    path === DATA_GROUP_ROOT
    || path.startsWith(`${DATA_GROUP_ROOT}/`)
    || path === APP_DATA_GROUP_ROOT
    || path.startsWith(`${APP_DATA_GROUP_ROOT}/`)
  );
}

/** 把组内路径规范成 `/...`；`''` / `'/'` 归一为 `''`（组根）。 */
function normalizeInner(innerPath: string): string {
  if (!innerPath || innerPath === '/') return '';
  return innerPath.startsWith('/') ? innerPath : `/${innerPath}`;
}

/**
 * 拼出数据组作用域下的树路径。
 *
 * admin 保持历史形式 `/@dg/<groupId>`；其它 appId 用 `/@adg/<appId>/<groupId>`。
 */
export function makeDataGroupPath(appId: string, groupId: string, innerPath: string): string {
  const inner = normalizeInner(innerPath);
  const base = appId === DEFAULT_DATA_GROUP_APP_ID
    ? `${DATA_GROUP_ROOT}/${groupId}`
    : `${APP_DATA_GROUP_ROOT}/${appId}/${groupId}`;
  return `${base}${inner}`;
}

/** 解析树路径 → appId + 组 id + 组内路径；非数据组路径返回 null。 */
export function parseDataGroupPath(path: string): DataGroupScope | null {
  if (!isDataGroupPath(path)) return null;

  if (path === DATA_GROUP_ROOT || path.startsWith(`${DATA_GROUP_ROOT}/`)) {
    const rest = path.slice(DATA_GROUP_ROOT.length); // '' 或 '/gid/...'
    const parts = rest.split('/').filter(Boolean);
    return {
      appId: DEFAULT_DATA_GROUP_APP_ID,
      groupId: parts[0] ?? '',
      inner: parts.length > 1 ? `/${parts.slice(1).join('/')}` : '/',
    };
  }

  const rest = path.slice(APP_DATA_GROUP_ROOT.length); // '' 或 '/appId/gid/...'
  const parts = rest.split('/').filter(Boolean);
  return {
    appId: parts[0] ?? '',
    groupId: parts[1] ?? '',
    inner: parts.length > 2 ? `/${parts.slice(2).join('/')}` : '/',
  };
}

/** 树路径 → 实际传给 fs 的路径（数据组需去掉 `/@dg/...` / `/@adg/...` 前缀）。 */
export function fsPathFor(path: string): string {
  return parseDataGroupPath(path)?.inner ?? path;
}

/** 数据组容器节点的树路径（如 `/@dg`）。 */
export const DATA_GROUPS_ROOT_PATH = DATA_GROUP_ROOT;
