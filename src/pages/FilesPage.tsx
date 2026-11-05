import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';
import { DATA_GROUPS_ROOT_PATH, fsPathFor, makeDataGroupPath, parseDataGroupPath } from '../data-group-path';
import {
  collectDataGroupOverview,
  isOverviewPath,
  makeOverviewAppPath,
  makeOverviewEntryPath,
  type DataGroupOverview,
  type DataGroupOverviewEntry,
} from '../data-group-overview';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:files');

/** 当前 repo 挂载的 appId 命名空间；只有它的数据组能真正浏览。 */
const ADMIN_APP_ID = 'admin';

// ---------------------------------------------------------------------------
// JSON Syntax Highlighter
//
// Lightweight regex-based tokenizer that produces HTML spans for syntax
// coloring. Used in an overlay <pre> behind a transparent <textarea>.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightJson(text: string): string {
  const tokenRegex =
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}\[\],])/g;

  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRegex.exec(text)) !== null) {
    if (m.index > last) result += escapeHtml(text.slice(last, m.index));
    const [, key, str, num, bool, punct] = m;
    if (key) {
      const km = key.match(/^("(?:\\.|[^"\\])*")(\s*:)$/);
      if (km) {
        result += `<span class="json-key">${escapeHtml(km[1])}</span>${escapeHtml(km[2])}`;
      } else {
        result += `<span class="json-key">${escapeHtml(key)}</span>`;
      }
    } else if (str) {
      result += `<span class="json-string">${escapeHtml(str)}</span>`;
    } else if (num) {
      result += `<span class="json-number">${escapeHtml(num)}</span>`;
    } else if (bool) {
      result += `<span class="json-bool">${escapeHtml(bool)}</span>`;
    } else if (punct) {
      result += `<span class="json-punct">${escapeHtml(punct)}</span>`;
    }
    last = tokenRegex.lastIndex;
  }
  if (last < text.length) result += escapeHtml(text.slice(last));
  return result;
}

interface TreeNode {
  name: string;
  /** 树路径：配置仓即真实路径；数据组带 `/@dg/<groupId>` 前缀。 */
  path: string;
  /**
   * 作用域前缀：该节点所在的命名空间。
   * 配置仓为 `''`，数据组内为 `/@dg/<groupId>`。
   * 子节点继承父节点的前缀，于是 `resolveFs(prefix)` 总能得到正确的 fs。
   */
  prefix: string;
  isDir: boolean;
  loaded: boolean;   // whether children have been loaded
  children: TreeNode[];
  /**
   * 虚拟节点类型：
   * · `data-groups`：虚拟容器
   * · `data-groups-app`：按 appId 分组
   * · `data-group`：当前 appId 下可浏览的数据组
   * · `data-group-readonly`：跨 appId 只读条目（不可编辑/删除/浏览）
   */
  kind?: 'data-groups' | 'data-groups-app' | 'data-group' | 'data-group-readonly';
  /** 只读条目：点击不选中、不加载子节点。 */
  readonly?: boolean;
  /** 仅用于展开/收起的分组节点：点击不选中。 */
  selectable?: boolean;
  /** 行内徽标：组 id / appId / groupType。 */
  idBadge?: string;
  appIdBadge?: string;
  groupType?: string;
  /** 悬浮说明（只读原因 / 无法解析原因）。 */
  note?: string;
  /** 无法解析 / 激活失败时的红色徽标文案。 */
  problemBadge?: string;
}

/**
 * 总览条目 → 树节点。
 *
 * 只有当前 appId（admin）且描述符有效、组已激活的数据组保持可浏览；
 * 其余（跨 appId / 坏 JSON / 非 data-sync / 未激活）均为只读节点。
 */
function buildOverviewEntryNode(
  appId: string,
  entry: DataGroupOverviewEntry,
  getDataGroupFs: (id: string) => any,
): TreeNode {
  const label = entry.name ?? entry.id;
  const browseable =
    appId === ADMIN_APP_ID &&
    entry.parsed &&
    entry.isDataSync &&
    !!getDataGroupFs(entry.id);

  if (browseable) {
    const groupPath = makeDataGroupPath(entry.id, '/');
    return {
      name: label,
      path: groupPath,
      prefix: groupPath,
      isDir: true,
      loaded: false,
      children: [],
      kind: 'data-group',
      idBadge: entry.id,
      appIdBadge: appId,
      groupType: entry.groupType ?? undefined,
    };
  }

  const notes: string[] = [];
  if (entry.problem) notes.push(entry.problem);
  else if (!entry.isDataSync) notes.push(`非 data-sync（${entry.groupType ?? '未知'}）：仅展示，不当作数据组`);
  else if (appId !== ADMIN_APP_ID) notes.push('只读：跨 appId 总览，当前 repo 无对应组 fs');
  else notes.push('只读：该组未激活');

  return {
    name: label,
    path: makeOverviewEntryPath(appId, entry.id),
    prefix: '',
    isDir: false,
    loaded: true,
    children: [],
    kind: 'data-group-readonly',
    readonly: true,
    idBadge: entry.id,
    appIdBadge: appId,
    groupType: entry.groupType ?? undefined,
    note: notes.join('；'),
    problemBadge: entry.problem
      ? (entry.problem.startsWith('激活失败') ? '未激活' : '无法解析')
      : undefined,
  };
}

/**
 * Load children of a directory. Only does one level — no recursion.
 * Uses mode bits to detect directories; no fallback readdir.
 *
 * @param prefix 树路径前缀（数据组为 `/@dag/<groupId>`，配置仓为 `''`），
 *               子节点路径 = prefix + fs 内的真实路径。
 */
async function loadChildren(fs: any, dir: string, prefix = ''): Promise<TreeNode[]> {
  const entries: TreeNode[] = [];
  try {
    const items = await fs.readdir(dir);
    for (const item of items) {
      const fullPath = dir === '/' ? `/${item}` : `${dir}/${item}`;
      try {
        const stat = await fs.stat(fullPath);
        const isDir = stat.mode !== undefined && (stat.mode & 0o40000) === 0o40000;
        entries.push({
          name: item,
          path: `${prefix}${fullPath}`,
          prefix,
          isDir,
          loaded: !isDir,   // files are pre-loaded (no children), dirs need expansion
          children: [],
        });
      } catch {
        // stat failed, skip
      }
    }
  } catch {
    // readdir failed
  }
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function FileTree({ rootNodes, resolveFs, selected, onSelect, version }: {
  rootNodes: TreeNode[];
  resolveFs: (path: string) => any;
  selected: string;
  onSelect: (path: string) => void;
  /** Bumped after deletes: remounts the tree so expanded dirs reload children. */
  version: number;
}) {
  return (
    <div className="file-tree">
      {rootNodes.map(n => (
        <TreeNodeView
          key={`${n.path}#${version}`}
          node={n}
          resolveFs={resolveFs}
          selected={selected}
          onSelect={onSelect}
          depth={0}
        />
      ))}
    </div>
  );
}

function TreeNodeView({ node, resolveFs, selected, onSelect, depth }: {
  node: TreeNode;
  resolveFs: (path: string) => any;
  selected: string;
  onSelect: (path: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [children, setChildren] = useState<TreeNode[]>(node.children);

  // 数据组列表是异步到达的，容器节点的 children 会随之变化
  useEffect(() => { setChildren(node.children); }, [node.children]);

  const handleClick = async () => {
    // 跨 appId 只读条目：不可选中、不可进入浏览
    if (node.readonly) return;
    if (!node.isDir) {
      onSelect(node.path);
      return;
    }
    // Toggle expand
    if (expanded) {
      setExpanded(false);
      return;
    }
    // Load children if not yet loaded
    if (!node.loaded) {
      const fs = resolveFs(node.prefix || node.path);
      if (!fs) return;
      setLoading(true);
      try {
        const loaded = await loadChildren(fs, fsPathFor(node.path), node.prefix);
        node.children = loaded;
        node.loaded = true;
        setChildren(loaded);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
    if (node.selectable !== false) onSelect(node.path);
  };

  return (
    <div>
      <div
        className={`tree-item ${node.isDir ? 'directory' : ''} ${selected === node.path ? 'active' : ''}`}
        onClick={handleClick}
        title={node.note}
        style={{ cursor: node.readonly ? 'default' : 'pointer' }}
      >
        <span style={{ width: 20, display: 'inline-block', textAlign: 'center' }}>
          {loading ? '⟳' : node.isDir ? (expanded ? '▼' : '▶') : ''}
        </span>
        <span style={{ marginRight: 4 }}>
          {node.kind === 'data-groups' || node.kind === 'data-groups-app' || node.kind === 'data-group'
            ? '🗂️'
            : node.kind === 'data-group-readonly' ? '🔒'
              : node.isDir ? '📁' : '📄'}
        </span>
        <span>{node.name}</span>
        {node.idBadge && (
          <span className="badge badge-primary" style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px' }}>{node.idBadge}</span>
        )}
        {node.appIdBadge && (
          <span
            className="badge"
            style={{ marginLeft: 4, fontSize: 10, padding: '1px 6px', background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
          >
            {node.appIdBadge}
          </span>
        )}
        {node.groupType && (
          <span
            className={`badge ${node.groupType === 'data-sync' ? 'badge-success' : 'badge-warning'}`}
            style={{ marginLeft: 4, fontSize: 10, padding: '1px 6px' }}
          >
            {node.groupType}
          </span>
        )}
        {node.problemBadge && (
          <span className="badge badge-danger" style={{ marginLeft: 4, fontSize: 10, padding: '1px 6px' }}>{node.problemBadge}</span>
        )}
      </div>
      {expanded && children.length > 0 && (
        <div className="tree-children">
          {children.map(c => (
            <TreeNodeView key={c.path} node={c} resolveFs={resolveFs} selected={selected} onSelect={onSelect} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FilesPage() {
  const { repo, dataGroups, getDataGroupFs } = useConfigRepo();
  const params = useParams();
  const navigate = useNavigate();
  const [configNodes, setConfigNodes] = useState<TreeNode[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [overview, setOverview] = useState<DataGroupOverview>({ apps: [], total: 0 });
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [versionInfo, setVersionInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const highlightRef = useRef<HTMLPreElement>(null);

  /** 按树路径解析出应该使用的 fs（配置仓 or 某个数据组）。 */
  const resolveFs = useCallback((path: string): any => {
    const parsed = parseDataGroupPath(path);
    if (parsed) return getDataGroupFs(parsed.groupId);
    return repo?.rootFS?.promises ?? null;
  }, [repo, getDataGroupFs]);

  // Load config-repo root level once
  useEffect(() => {
    if (!repo) return;
    setLoading(true);
    // 配置仓节点的作用域前缀为空串
    loadChildren(repo.rootFS.promises, '/', '')
      .then(nodes => setConfigNodes(nodes))
      .finally(() => setLoading(false));
  }, [repo]);

  // 跨 appId 数据组总览：直接读仓库根 fs 的 `.config` / `.meta` 描述符
  useEffect(() => {
    if (!repo) {
      setOverview({ apps: [], total: 0 });
      setOverviewLoading(false);
      setOverviewLoaded(false);
      return;
    }
    let cancelled = false;
    setOverviewLoading(true);
    collectDataGroupOverview(repo.rootFS.promises)
      .then(res => { if (!cancelled) setOverview(res); })
      .catch((err: any) => {
        log.warn('[FilesPage] data group overview failed:', err?.message ?? err);
        if (!cancelled) setOverview({ apps: [], total: 0 });
      })
      .finally(() => {
        if (!cancelled) {
          setOverviewLoading(false);
          setOverviewLoaded(true);
        }
      });
    return () => { cancelled = true; };
  }, [repo]);

  /**
   * 把总览条目转成树节点。
   * 只有当前 appId（admin）且描述符有效、组已激活的数据组可浏览；
   * 其余一律只读（无对应组 fs，禁止编辑/删除/进入）。
   */
  const overviewAppNodes = useMemo<TreeNode[]>(() => {
    const apps = overview.apps.map(app => ({ ...app }));
    // 描述符读取失败时回退到 context 中已激活的 admin 组，保持原有可浏览行为
    if (!apps.some(a => a.appId === ADMIN_APP_ID) && dataGroups.length > 0) {
      apps.push({
        appId: ADMIN_APP_ID,
        entries: dataGroups.map(g => ({
          appId: ADMIN_APP_ID,
          id: g.id,
          descriptorId: g.id,
          name: null,
          groupType: g.error ? null : 'data-sync',
          backendsCount: g.backends?.length ?? 0,
          source: 'config',
          parsed: !g.error,
          isDataSync: !g.error,
          problem: g.error ? `激活失败：${g.error}` : null,
        })),
      });
    }
    apps.sort((a, b) => a.appId.localeCompare(b.appId));

    return apps.map(app => ({
      name: `${app.appId} (${app.entries.length})`,
      path: makeOverviewAppPath(app.appId),
      prefix: DATA_GROUPS_ROOT_PATH,
      isDir: true,
      loaded: true,
      kind: 'data-groups-app' as const,
      selectable: false,
      children: app.entries.map(entry => buildOverviewEntryNode(app.appId, entry, getDataGroupFs)),
    }));
  }, [overview, dataGroups, getDataGroupFs]);

  // 树根 = 配置仓节点 + 虚拟 “Data Groups” 节点（无数据组时不渲染该容器）
  const rootNodes = useMemo<TreeNode[]>(() => {
    if (overviewAppNodes.length === 0) return configNodes;
    const dataGroupsNode: TreeNode = {
      name: 'Data Groups',
      path: DATA_GROUPS_ROOT_PATH,
      prefix: DATA_GROUPS_ROOT_PATH,
      isDir: true,
      loaded: true,
      kind: 'data-groups',
      children: overviewAppNodes,
    };
    return [...configNodes, dataGroupsNode];
  }, [configNodes, overviewAppNodes]);

  const effectivePath = (params['*'] ? `/${params['*']}` : selectedPath) || '';
  /** 只读总览条目的树路径：没有对应 fs，不加载内容。 */
  const isOverviewEntry = isOverviewPath(effectivePath);
  const scope = useMemo(() => parseDataGroupPath(effectivePath), [effectivePath]);
  const fsPath = scope ? scope.inner : effectivePath;

  useEffect(() => {
    if (!repo || !effectivePath) return;
    if (isOverviewPath(effectivePath)) {
      setContent('');
      setOriginalContent('');
      setVersionInfo(null);
      return;
    }
    const fs = resolveFs(effectivePath);
    if (!fs) {
      setContent('');
      setOriginalContent('');
      return;
    }
    fs.stat(fsPath).then(async (s: any) => {
      const isDir = s.mode !== undefined && (s.mode & 0o40000) === 0o40000;
      if (!isDir) {
        return fs.readFile(fsPath, 'utf-8');
      }
      return null;
    }).then((text: string | null) => {
      const decoded = text != null
        ? (typeof text === 'string' ? text : new TextDecoder().decode(text as Uint8Array))
        : null;
      if (decoded != null) {
        setContent(decoded);
        setOriginalContent(decoded);
        setSelectedPath(effectivePath);
      } else {
        setContent('');
        setOriginalContent('');
      }
    }).catch((err: any) => {
      log.warn('[FilesPage] load file error:', err.message);
      setContent('');
      setOriginalContent('');
    });

    // 数据组没有配置仓的 `.version` sidecar 体系 —— 跳过版本信息
    if (scope) {
      setVersionInfo(null);
      return;
    }

    // Load version info
    import('zen-fs-config').then(({ versionPathFor }) => {
      const vp = versionPathFor(effectivePath);
      if (!vp) return;
      fs.readFile(vp, 'utf-8').then((v: any) => {
        const str = typeof v === 'string' ? v : new TextDecoder().decode(v as Uint8Array);
        setVersionInfo(JSON.parse(str));
      }).catch(() => setVersionInfo(null));
    });
  }, [repo, effectivePath, fsPath, scope, resolveFs]);

  const handleSelect = (path: string) => {
    const relative = path.startsWith('/') ? path.slice(1) : path;
    navigate(`/files/${relative}`);
  };

  const isJson = fsPath.endsWith('.json');

  const handleSave = async () => {
    if (!repo || !effectivePath) return;
    const fs = resolveFs(effectivePath);
    if (!fs) return;
    setSaving(true);
    setMessage('');
    try {
      if (scope) {
        // 数据组：直接写组 fs（没有 setConfig / 版本 sidecar 体系）
        const data = isJson ? JSON.stringify(JSON.parse(content), null, 2) : content;
        await fs.writeFile(fsPath, data);
      } else {
        const appId = repo.appId;
        const isInAppDir = effectivePath.startsWith(`/${appId}/`);
        if (isInAppDir) {
          let data: unknown = content;
          if (isJson) data = JSON.parse(content);
          repo.setConfig(effectivePath.slice(`/${appId}`.length), data);
        } else {
          const data = isJson ? JSON.stringify(JSON.parse(content), null, 2) : content;
          await fs.writeFile(effectivePath, data);
        }
      }
      setMessage('Saved');
      setOriginalContent(content);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(content);
      setContent(JSON.stringify(parsed, null, 2));
    } catch {
      setMessage('Invalid JSON');
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    if (!repo || !effectivePath || effectivePath === '/') return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    const fs = resolveFs(effectivePath);
    if (!fs) return;
    setDeleting(true);
    setMessage('');
    try {
      if (scope) {
        await fs.unlink(fsPath);
      } else {
        await repo.deleteFile(effectivePath);
      }
      setMessage('Deleted');
      setContent('');
      setOriginalContent('');
      setSelectedPath('');
      // TreeNodeView caches children once expanded, so a deleted directory
      // would otherwise stay visible until a full page reload.
      setConfigNodes(await loadChildren(repo.rootFS.promises, '/', ''));
      setTreeVersion(v => v + 1);
      navigate('/files');
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  if (!repo) return <div className="loading">No repo connected</div>;

  const hasChanges = content !== originalContent;

  return (
    <div className="split-pane">
      <div className="split-pane-left">
        {loading && <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12 }}>Loading files...</div>}
        {overviewLoading && (
          <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12 }}>Loading data groups...</div>
        )}
        {overviewLoaded && !overviewLoading && overviewAppNodes.length === 0 && (
          <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12 }}>
            No data groups found in .config/ or .meta/
          </div>
        )}
        {!loading && rootNodes.length === 0 && (
          <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 13 }}>No files</div>
        )}
        <FileTree
          rootNodes={rootNodes}
          resolveFs={resolveFs}
          selected={selectedPath}
          onSelect={handleSelect}
          version={treeVersion}
        />
      </div>
      <div className="split-pane-right">
        {isOverviewEntry ? (
          <div className="empty-state">
            <div className="icon">🔒</div>
            <p>只读总览条目：不可编辑、删除或进入浏览</p>
          </div>
        ) : effectivePath ? (
          <div className="editor-container">
            <div className="editor-toolbar">
              <span className="editor-path">{effectivePath}</span>
              {scope && <span className="badge badge-primary" style={{ marginLeft: 8 }}>data group: {scope.groupId}</span>}
              {isJson && (
                <button className="btn btn-sm btn-secondary" onClick={handleFormat}>Format</button>
              )}
              {hasChanges && (
                <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              )}
              {effectivePath && effectivePath !== '/' && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={handleDelete}
                  disabled={deleting}
                  style={{ marginLeft: 'auto', marginRight: 8 }}
                >
                  {confirmDelete ? 'Confirm Delete?' : 'Delete'}
                </button>
              )}
              {versionInfo && (
                <span className="badge badge-success" style={{ marginLeft: 'auto' }}>
                  v{versionInfo.version} {versionInfo.hash.slice(0, 12)}
                </span>
              )}
              {message && <span style={{ color: message.includes('Error') ? 'var(--danger)' : 'var(--success)', fontSize: 12 }}>{message}</span>}
            </div>
            {versionInfo && (
              <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
                version: {versionInfo.version} | hash: {versionInfo.hash} | author: {versionInfo.author} | {new Date(versionInfo.timestamp).toLocaleString()}
              </div>
            )}
            {isJson ? (
              <div className="json-editor-overlay">
                <pre
                  ref={highlightRef}
                  className="json-highlight-layer"
                  dangerouslySetInnerHTML={{ __html: highlightJson(content) + '\n' }}
                  aria-hidden="true"
                />
                <textarea
                  className="editor-textarea json-editor-input"
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  onScroll={e => {
                    if (highlightRef.current) {
                      highlightRef.current.scrollTop = e.currentTarget.scrollTop;
                      highlightRef.current.scrollLeft = e.currentTarget.scrollLeft;
                    }
                  }}
                  spellCheck={false}
                />
              </div>
            ) : (
              <textarea
                className="editor-textarea"
                value={content}
                onChange={e => setContent(e.target.value)}
                spellCheck={false}
              />
            )}
          </div>
        ) : (
          <div className="empty-state">
            <div className="icon">▣</div>
            <p>Select a file to view or edit</p>
          </div>
        )}
      </div>
    </div>
  );
}
