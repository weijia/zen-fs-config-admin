/**
 * 跨 appId 数据组 / 配置组描述符的只读总览。
 *
 * 数据来源是配置仓的**仓库根 fs**（`repo.rootFS`，未 chroot 到 appId）：
 *   · `.config/app-data-groups/{appId}/{id}.json`  （新布局，优先）
 *   · `.meta/app-data-groups/{appId}/{id}.json`    （legacy 布局，兜底）
 *
 * 与 `repo.listAppDataGroups()` 的区别：
 *   · 枚举**所有** appId 子目录，而不只是当前 appId；
 *   · 坏 JSON / 缺字段 / 非 data-sync 的描述符不会被静默丢弃，而是带 `problem`
 *     或 `isDataSync=false` 返回，供 UI 显式展示。
 *
 * 去重规则：同一 appId + 文件名（即 id）以 `.config` 为准，`.meta` 中的同名
 * 描述符不再重复出现。
 *
 * 只读约束：跨 appId 的组没有对应的本地组 fs（admin 的 repo 只挂载
 * `admin` 命名空间），因此 UI 只展示不进入浏览。
 */

/** 新布局根目录（仓库根 fs 的绝对路径）。 */
export const APP_DATA_GROUPS_DIR = '/.config/app-data-groups';
/** legacy 布局根目录（仓库根 fs 的绝对路径）。 */
export const LEGACY_APP_DATA_GROUPS_DIR = '/.meta/app-data-groups';

/** 总览条目的树路径前缀（与数据组的 `/@dg` 区分开）。 */
const OVERVIEW_PREFIX = '/@dgo';

export interface DataGroupOverviewEntry {
  appId: string;
  /** 描述符文件名去掉 `.json`；也是 `.config` / `.meta` 去重的键。 */
  id: string;
  /** 描述符里声明的 id；JSON 无法解析或未声明时为 null。 */
  descriptorId: string | null;
  /** 显示名（描述符 `name`），没有时由 UI 回退到 id。 */
  name: string | null;
  /** 描述符 `groupType`；缺失或无法解析时为 null。 */
  groupType: string | null;
  /** 后端数量（`backends` 数组长度）。 */
  backendsCount: number;
  /** 命中布局：`config` 优先，`meta` 为 legacy。 */
  source: 'config' | 'meta';
  /** 描述符结构是否完整（JSON 可解析且 id/groupType 齐全）。 */
  parsed: boolean;
  /** 是否 `groupType === 'data-sync'`（否则只做展示，不当作数据组）。 */
  isDataSync: boolean;
  /** 无法解析 / 缺字段的原因；正常条目为 null。 */
  problem: string | null;
}

export interface DataGroupOverviewApp {
  appId: string;
  entries: DataGroupOverviewEntry[];
}

export interface DataGroupOverview {
  apps: DataGroupOverviewApp[];
  /** 总条目数（去重后）。 */
  total: number;
}

/** 跨 appId 总览条目的树路径（纯展示，不能解析成数据组 fs 路径）。 */
export function makeOverviewEntryPath(appId: string, id: string): string {
  return `${OVERVIEW_PREFIX}/${appId}/${id}`;
}

/** appId 分组节点的树路径。 */
export function makeOverviewAppPath(appId: string): string {
  return `${OVERVIEW_PREFIX}/${appId}`;
}

/** 树路径是否属于只读总览（这类路径不映射到任何 fs）。 */
export function isOverviewPath(path: string): boolean {
  return path === OVERVIEW_PREFIX || path.startsWith(`${OVERVIEW_PREFIX}/`);
}

async function toText(raw: unknown): Promise<string> {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return new TextDecoder().decode(raw as Uint8Array);
}

/**
 * 读取单个描述符文件。
 * 读取失败 / JSON 非法 / 缺字段都不抛错，而是返回带 `problem` 的条目。
 */
async function readDescriptor(
  fs: any,
  appId: string,
  id: string,
  source: 'config' | 'meta',
  path: string,
): Promise<DataGroupOverviewEntry> {
  const base: DataGroupOverviewEntry = {
    appId,
    id,
    descriptorId: null,
    name: null,
    groupType: null,
    backendsCount: 0,
    source,
    parsed: false,
    isDataSync: false,
    problem: null,
  };

  let parsed: any;
  try {
    parsed = JSON.parse(await toText(await fs.readFile(path)));
  } catch (err: any) {
    return { ...base, problem: `无法解析：${err?.message ?? String(err)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, problem: '无法解析：描述符不是 JSON 对象' };
  }

  const descriptorId = typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
  const groupType = typeof parsed.groupType === 'string' && parsed.groupType ? parsed.groupType : null;
  const entry: DataGroupOverviewEntry = {
    ...base,
    descriptorId,
    groupType,
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null,
    backendsCount: Array.isArray(parsed.backends) ? parsed.backends.length : 0,
    parsed: descriptorId !== null && groupType !== null,
    isDataSync: groupType === 'data-sync',
  };

  if (!descriptorId || !groupType) {
    const missing = [
      descriptorId ? null : 'id',
      groupType ? null : 'groupType',
    ].filter(Boolean).join(' / ');
    entry.problem = `无法解析：缺少 ${missing}`;
  }
  return entry;
}

/**
 * 扫描一种布局，写入 `byApp`。
 * 先扫 `.config`，因此 `byApp` 中已存在的同 appId+id 不会被 `.meta` 覆盖。
 */
async function scanLayout(
  fs: any,
  root: string,
  source: 'config' | 'meta',
  byApp: Map<string, Map<string, DataGroupOverviewEntry>>,
): Promise<void> {
  let appIds: string[];
  try {
    appIds = await fs.readdir(root);
  } catch {
    return; // 该布局不存在（例如 `.config` 尚未迁移）
  }

  for (const appId of appIds) {
    if (appId.startsWith('.')) continue; // 跳过 `.keep` 之类的占位文件
    let files: string[];
    try {
      files = await fs.readdir(`${root}/${appId}`);
    } catch {
      continue; // 不是目录
    }
    const entries = byApp.get(appId) ?? new Map<string, DataGroupOverviewEntry>();
    byApp.set(appId, entries);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (entries.has(id)) continue; // `.config` 已命中 → 忽略 legacy
      entries.set(
        id,
        await readDescriptor(fs, appId, id, source, `${root}/${appId}/${file}`),
      );
    }
  }
}

/**
 * 读取仓库 fs 上的全部 appId 数据组描述符（只读）。
 *
 * @param fs 仓库根 fs（`repo.rootFS.promises` 或兼容对象）。
 */
export async function collectDataGroupOverview(fs: any): Promise<DataGroupOverview> {
  if (!fs) return { apps: [], total: 0 };

  const byApp = new Map<string, Map<string, DataGroupOverviewEntry>>();
  await scanLayout(fs, APP_DATA_GROUPS_DIR, 'config', byApp);
  await scanLayout(fs, LEGACY_APP_DATA_GROUPS_DIR, 'meta', byApp);

  const apps: DataGroupOverviewApp[] = Array.from(byApp.entries())
    .map(([appId, entries]) => ({
      appId,
      entries: Array.from(entries.values()).sort((a, b) => {
        const an = a.name ?? a.id;
        const bn = b.name ?? b.id;
        return an.localeCompare(bn) || a.id.localeCompare(b.id);
      }),
    }))
    .filter(app => app.entries.length > 0)
    .sort((a, b) => a.appId.localeCompare(b.appId));

  return {
    apps,
    total: apps.reduce((sum, app) => sum + app.entries.length, 0),
  };
}
