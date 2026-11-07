import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useSyncTarget } from '../context/SyncTargetContext';
import { fsPathFor, parseDataGroupPath } from '../data-group-path';
import { targetKindLabel, targetPathPrefix } from '../sync-target';
import { versionPathFor } from 'zen-fs-config';
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
  /** 树路径：配置组为 fs 相对路径；数据组带 `/@dg/<groupId>` 前缀。 */
  path: string;
  /** 作用域前缀（配置组 `''`，数据组为组路径前缀）。 */
  prefix: string;
  isDir: boolean;
  loaded: boolean;
  children: TreeNode[];
}

/** 读取一层目录。 */
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
          loaded: !isDir,
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

function TreeNodeView({ node, fs, selected, onSelect, depth }: {
  node: TreeNode;
  fs: any;
  selected: string;
  onSelect: (path: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [children, setChildren] = useState<TreeNode[]>(node.children);

  useEffect(() => { setChildren(node.children); }, [node.children]);

  const handleClick = async () => {
    if (!node.isDir) {
      onSelect(node.path);
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!node.loaded) {
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
        <span style={{ marginRight: 4 }}>{node.isDir ? '📁' : '📄'}</span>
        <span>{node.name}</span>
      </div>
      {expanded && children.length > 0 && (
        <div className="tree-children">
          {children.map(c => (
            <TreeNodeView key={c.path} node={c} fs={fs} selected={selected} onSelect={onSelect} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FilesPage() {
  const {
    selected,
    selectedOption,
    ready,
    opening,
    error,
    fs,
    handle,
    flushTarget,
    getSyncStatuses,
  } = useSyncTarget();
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeVersion, setTreeVersion] = useState(0);
  const [selectedPath, setSelectedPath] = useState('');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [versionInfo, setVersionInfo] = useState<any>(null);
  const [selectedIsDir, setSelectedIsDir] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const highlightRef = useRef<HTMLPreElement>(null);
  const search = location.search;

  const prefix = targetPathPrefix(selected);
  const urlPath = params['*'] ? `/${params['*']}` : '';
  const effectivePath = urlPath || selectedPath;

  const scope = parseDataGroupPath(effectivePath);
  /** 路径必须属于当前选中的组，避免切换过程中的旧路径被误读。 */
  const scopeMatches = selected.kind === 'data'
    ? !!scope && scope.appId === selected.appId && scope.groupId === selected.groupId
    : !scope;
  const fsPath = scopeMatches
    ? (selected.kind === 'data' ? scope!.inner : effectivePath)
    : '';

  // 切换 target 后清空当前文件选择。
  useEffect(() => {
    setSelectedPath('');
    setContent('');
    setOriginalContent('');
    setVersionInfo(null);
  }, [selected.kind, selected.appId, selected.groupId]);

  // 目标就绪后加载组根目录；treeVersion 用于删除 / 新建后强制刷新。
  useEffect(() => {
    if (!ready || !fs) {
      setRootNodes([]);
      return;
    }
    let cancelled = false;
    setTreeLoading(true);
    loadChildren(fs, '/', prefix)
      .then(nodes => { if (!cancelled) setRootNodes(nodes); })
      .finally(() => { if (!cancelled) setTreeLoading(false); });
    return () => { cancelled = true; };
  }, [ready, fs, prefix, treeVersion]);

  // 读取当前文件内容。
  useEffect(() => {
    if (!ready || !fs || !effectivePath || !fsPath) {
      setContent('');
      setOriginalContent('');
      setSelectedIsDir(false);
      return;
    }
    let cancelled = false;
    fs.stat(fsPath).then(async (s: any) => {
      const isDir = s.mode !== undefined && (s.mode & 0o40000) === 0o40000;
      if (cancelled) return null;
      setSelectedIsDir(isDir);
      if (!isDir) {
        return fs.readFile(fsPath, 'utf-8');
      }
      return null;
    }).then((text: string | null) => {
      if (cancelled) return;
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
      if (cancelled) return;
      log.warn('[FilesPage] load file error:', err.message);
      setSelectedIsDir(false);
      setContent('');
      setOriginalContent('');
    });

    if (selected.kind !== 'config') {
      setVersionInfo(null);
      return () => { cancelled = true; };
    }
    const vp = versionPathFor(fsPath);
    if (vp) {
      const versionPath = vp.startsWith('/') ? vp : `/${vp}`;
      fs.readFile(versionPath, 'utf-8').then((v: any) => {
        if (cancelled) return;
        const str = typeof v === 'string' ? v : new TextDecoder().decode(v as Uint8Array);
        setVersionInfo(JSON.parse(str));
      }).catch(() => { if (!cancelled) setVersionInfo(null); });
    }
    return () => { cancelled = true; };
  }, [ready, fs, effectivePath, fsPath, selected.kind]);

  const handleSelect = (path: string) => {
    const relative = path.startsWith('/') ? path.slice(1) : path;
    navigate(`/files/${relative}${search}`);
  };

  const isJson = fsPath.endsWith('.json');
  const hasChanges = content !== originalContent;

  const handleSave = async () => {
    if (!ready || !fs || !effectivePath || !fsPath) return;
    setSaving(true);
    setMessage('');
    try {
      if (selected.kind === 'data') {
        const data = isJson ? JSON.stringify(JSON.parse(content), null, 2) : content;
        await fs.writeFile(fsPath, data);
        const synced = (await flushTarget()).length;
        setMessage(synced ? `Saved（已触发同步：${synced} 个目标）` : 'Saved（已写入本地）');
      } else {
        const repoHandle = handle as any;
        if (isJson) {
          repoHandle.setConfig(fsPath, JSON.parse(content));
        } else {
          await fs.writeFile(fsPath, content);
        }
        setMessage('Saved');
      }
      setOriginalContent(content);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const handleCreate = async (kind: 'file' | 'dir') => {
    if (!ready || !fs || !effectivePath || !fsPath) return;
    const name = window.prompt(kind === 'dir' ? '新建目录名' : '新建文件名');
    if (!name) return;
    if (name === '.' || name === '..' || /[\\/]/.test(name)) {
      setMessage('Error: 名称不能包含路径分隔符');
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    const baseDir = selectedIsDir ? fsPath : (fsPath.replace(/\/[^/]*$/, '') || '/');
    const target = `${baseDir === '/' ? '' : baseDir}/${name}`;
    try {
      if (kind === 'dir') await fs.mkdir(target);
      else await fs.writeFile(target, '');
      const synced = selected.kind === 'data' ? (await flushTarget()).length : 0;
      setTreeVersion(v => v + 1);
      setMessage(synced ? `Created（已触发同步：${synced} 个目标）` : 'Created');
      handleSelect(`${prefix}${target}`);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const handleFlush = async () => {
    if (!ready) return;
    setFlushing(true);
    setMessage('');
    try {
      const results = await flushTarget();
      setMessage(results.length ? `Flushed：${results.length} 个目标` : 'Flushed');
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setFlushing(false);
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
    if (!ready || !fs || !effectivePath || !fsPath) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setDeleting(true);
    setMessage('');
    try {
      if (selected.kind === 'data') {
        // 删除必须走组 fs 的 unlink / rmdir，才能写墓碑并传播到各后端。
        const st = await fs.stat(fsPath);
        const isDir = st.mode !== undefined && (st.mode & 0o40000) === 0o40000;
        if (isDir) await fs.rmdir(fsPath);
        else await fs.unlink(fsPath);
        const synced = (await flushTarget()).length;
        setMessage(synced ? `Deleted（已触发同步：${synced} 个目标）` : 'Deleted（已写入本地）');
      } else {
        // ConfigRepo.deleteFile 走 cachedFS（含 /{appId} 前缀），与 chroot 后的 fsPath 不同。
        await (handle as any).deleteFile(`/${selected.appId}${fsPath}`);
        setMessage('Deleted');
      }
      setContent('');
      setOriginalContent('');
      setSelectedPath('');
      setTreeVersion(v => v + 1);
      navigate(`/files${search}`);
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
      setTimeout(() => setMessage(''), 3000);
    }
  };

  const statuses = useMemo(
    () => (ready ? getSyncStatuses() : new Map()),
    [ready, getSyncStatuses],
  );

  if (!ready) {
    return (
      <div className="split-pane">
        <div className="split-pane-left">
          <div style={{ padding: 16 }}>
            <div className="page-title" style={{ fontSize: 16, marginBottom: 8 }}>
              {selectedOption?.label ?? selectedKeyLabel(selected)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <div>
                <span className="badge badge-primary" style={{ marginRight: 6 }}>{targetKindLabel(selected)}</span>
                appId: <span className="mono">{selected.appId}</span>
                {selected.groupId && <span> · 组 id: <span className="mono">{selected.groupId}</span></span>}
              </div>
              {selectedOption && (
                <>
                  {selected.kind === 'config'
                    ? <div>后端：实例打开后从配置仓读取</div>
                    : <div>声明后端：{selectedOption.backendsCount}（来源：{selectedOption.backendsSource}）</div>}
                  <div>{selectedOption.detail}</div>
                </>
              )}
              {opening && (
                <div style={{ marginTop: 8, color: 'var(--warning)' }}>
                  正在后台建立实例并首次同步，完成后本页自动可写…
                </div>
              )}
              {error && (
                <div style={{ marginTop: 8, color: 'var(--danger)' }}>打开失败：{error}</div>
              )}
              {!opening && !error && selectedOption?.openState === 'closed' && (
                <div style={{ marginTop: 8 }}>首次选择将建立实例并同步，请稍候。</div>
              )}
            </div>
          </div>
        </div>
        <div className="split-pane-right">
          <div className="empty-state">
            <div className="icon">🔒</div>
            <p>组尚未打开：只读展示组信息</p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              打开完成后可以浏览 / 编辑文件，并查看同步状态。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="split-pane">
      <div className="split-pane-left">
        <div className="target-strip">
          <span className={`badge ${selected.kind === 'config' ? 'badge-primary' : 'badge-success'}`}>
            {targetKindLabel(selected)}
          </span>
          <span className="mono" style={{ fontSize: 11 }}>{selected.appId}</span>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{selectedOption?.label ?? selectedKeyLabel(selected)}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {statuses.size} 对 · {Array.from(statuses.values()).filter(s => s.watching).length} watching
          </span>
          {selected.kind === 'data' && (
            <button
              className="btn btn-sm btn-secondary"
              style={{ marginLeft: 'auto', fontSize: 11 }}
              onClick={handleFlush}
              disabled={flushing}
            >
              {flushing ? 'Flushing…' : 'Flush'}
            </button>
          )}
        </div>
        {treeLoading && <div className="tree-hint">Loading files...</div>}
        {!treeLoading && rootNodes.length === 0 && <div className="tree-hint">No files</div>}
        {rootNodes.map(n => (
          <TreeNodeView
            key={`${n.path}#${treeVersion}`}
            node={n}
            fs={fs}
            selected={selectedPath}
            onSelect={handleSelect}
            depth={0}
          />
        ))}
      </div>
      <div className="split-pane-right">
        {effectivePath && fsPath ? (
          <div className="editor-container">
            <div className="editor-toolbar">
              <span className="editor-path">{effectivePath}</span>
              <span className="badge badge-primary" style={{ marginLeft: 8 }}>
                {selected.kind === 'config' ? 'config' : `data group: ${selected.groupId}`}
              </span>
              {isJson && (
                <button className="btn btn-sm btn-secondary" onClick={handleFormat}>Format</button>
              )}
              <button className="btn btn-sm btn-secondary" onClick={() => handleCreate('file')}>New File</button>
              <button className="btn btn-sm btn-secondary" onClick={() => handleCreate('dir')}>New Folder</button>
              {hasChanges && (
                <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              )}
              {effectivePath !== '/' && (
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
              {message && (
                <span style={{ color: message.includes('Error') ? 'var(--danger)' : 'var(--success)', fontSize: 12 }}>
                  {message}
                </span>
              )}
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
            {message && (
              <p style={{ fontSize: 12, color: message.includes('Error') ? 'var(--danger)' : 'var(--success)' }}>{message}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function selectedKeyLabel(ref: { kind: string; appId: string; groupId: string | null }): string {
  return ref.kind === 'config' ? '配置同步组' : `${ref.appId} / ${ref.groupId}`;
}
