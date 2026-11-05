import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';
import { DATA_GROUPS_ROOT_PATH, fsPathFor, makeDataGroupPath, parseDataGroupPath } from '../data-group-path';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:files');

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
  /** 虚拟节点类型：数据组容器 / 单个数据组。缺省即配置仓普通节点。 */
  kind?: 'data-groups' | 'data-group';
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
    onSelect(node.path);
  };

  return (
    <div>
      <div
        className={`tree-item ${node.isDir ? 'directory' : ''} ${selected === node.path ? 'active' : ''}`}
        onClick={handleClick}
        style={{ cursor: 'pointer' }}
      >
        <span style={{ width: 20, display: 'inline-block', textAlign: 'center' }}>
          {loading ? '⟳' : node.isDir ? (expanded ? '▼' : '▶') : ''}
        </span>
        <span style={{ marginRight: 4 }}>
          {node.kind === 'data-groups' || node.kind === 'data-group' ? '🗂️' : node.isDir ? '📁' : '📄'}
        </span>
        <span>{node.name}</span>
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

  // 树根 = 配置仓节点 + 虚拟 “Data Groups” 节点
  const rootNodes = useMemo<TreeNode[]>(() => {
    const dataGroupsNode: TreeNode = {
      name: 'Data Groups',
      path: DATA_GROUPS_ROOT_PATH,
      prefix: DATA_GROUPS_ROOT_PATH,
      isDir: true,
      loaded: true,
      kind: 'data-groups',
      children: dataGroups.map(g => ({
        name: g.id,
        path: makeDataGroupPath(g.id, '/'),
        prefix: makeDataGroupPath(g.id, '/'),
        isDir: true,
        loaded: false,
        children: [],
        kind: 'data-group' as const,
      })),
    };
    return [...configNodes, dataGroupsNode];
  }, [configNodes, dataGroups]);

  const effectivePath = (params['*'] ? `/${params['*']}` : selectedPath) || '';
  const scope = useMemo(() => parseDataGroupPath(effectivePath), [effectivePath]);
  const fsPath = scope ? scope.inner : effectivePath;

  useEffect(() => {
    if (!repo || !effectivePath) return;
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
        {loading && <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12 }}>Loading...</div>}
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
        {effectivePath ? (
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
