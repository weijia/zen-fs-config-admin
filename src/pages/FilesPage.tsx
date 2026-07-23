import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  loaded: boolean;   // whether children have been loaded
  children: TreeNode[];
}

/**
 * Load children of a directory. Only does one level — no recursion.
 * Uses mode bits to detect directories; no fallback readdir.
 */
async function loadChildren(fs: any, dir: string): Promise<TreeNode[]> {
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
          path: fullPath,
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

function FileTree({ rootNodes, fs, selected, onSelect }: {
  rootNodes: TreeNode[];
  fs: any;
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="file-tree">
      {rootNodes.map(n => (
        <TreeNodeView key={n.path} node={n} fs={fs} selected={selected} onSelect={onSelect} depth={0} />
      ))}
    </div>
  );
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
      setLoading(true);
      try {
        const loaded = await loadChildren(fs, node.path);
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
  const { repo } = useConfigRepo();
  const params = useParams();
  const navigate = useNavigate();
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [versionInfo, setVersionInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const fsRef = useRef<any>(null);

  // Load root level once
  useEffect(() => {
    if (!repo) return;
    fsRef.current = repo.rootFS.promises;
    setLoading(true);
    loadChildren(repo.rootFS.promises, '/')
      .then(nodes => setRootNodes(nodes))
      .finally(() => setLoading(false));
  }, [repo]);

  const effectivePath = (params['*'] ? `/${params['*']}` : selectedPath) || '';

  useEffect(() => {
    if (!repo || !effectivePath) return;
    const fs = repo.rootFS.promises;
    fs.stat(effectivePath).then(async (s: any) => {
      const isDir = s.mode !== undefined && (s.mode & 0o40000) === 0o40000;
      if (!isDir) {
        return fs.readFile(effectivePath, 'utf-8');
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
      console.warn('[FilesPage] load file error:', err.message);
      setContent('');
      setOriginalContent('');
    });

    // Load version info
    import('zen-fs-config').then(({ versionPathFor }) => {
      const vp = versionPathFor(effectivePath);
      fs.readFile(vp, 'utf-8').then((v: any) => {
        const str = typeof v === 'string' ? v : new TextDecoder().decode(v as Uint8Array);
        setVersionInfo(JSON.parse(str));
      }).catch(() => setVersionInfo(null));
    });
  }, [repo, effectivePath]);

  const handleSelect = (path: string) => {
    const relative = path.startsWith('/') ? path.slice(1) : path;
    navigate(`/files/${relative}`);
  };

  const isJson = effectivePath.endsWith('.json');

  const handleSave = async () => {
    if (!repo || !effectivePath) return;
    const fs = repo.rootFS.promises;
    setSaving(true);
    setMessage('');
    try {
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
    setDeleting(true);
    setMessage('');
    try {
      await repo.deleteFile(effectivePath);
      setMessage('Deleted');
      setContent('');
      setOriginalContent('');
      setSelectedPath('');
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
        <FileTree rootNodes={rootNodes} fs={fsRef.current} selected={selectedPath} onSelect={handleSelect} />
      </div>
      <div className="split-pane-right">
        {effectivePath ? (
          <div className="editor-container">
            <div className="editor-toolbar">
              <span className="editor-path">{effectivePath}</span>
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
            <textarea
              className="editor-textarea"
              value={content}
              onChange={e => setContent(e.target.value)}
              spellCheck={false}
            />
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