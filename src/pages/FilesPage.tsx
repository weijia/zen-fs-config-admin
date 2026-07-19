import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

async function buildTree(fs: any, dir: string, depth = 0): Promise<TreeNode[]> {
  const indent = '  '.repeat(depth);
  console.log(`[buildTree] readdir(${dir})...`);
  const entries: TreeNode[] = [];
  try {
    const items = await fs.readdir(dir);
    console.log(`[buildTree] readdir(${dir}) => ${items.length} items:`, items);
    for (const item of items) {
      const fullPath = dir === '/' ? `/${item}` : `${dir}/${item}`;
      try {
        const stat = await fs.stat(fullPath);
        console.log(`${indent}[buildTree] stat(${fullPath}) => isDir=${stat.isDirectory()}, size=${stat.size}`);
        const node: TreeNode = { name: item, path: fullPath, isDir: stat.isDirectory(), children: [] };
        if (node.isDir) {
          node.children = await buildTree(fs, fullPath, depth + 1);
        }
        entries.push(node);
      } catch (err: any) {
        console.warn(`${indent}[buildTree] stat(${fullPath}) failed:`, err.message);
      }
    }
  } catch (err: any) {
    console.warn(`[buildTree] readdir(${dir}) failed:`, err.message);
  }
  console.log(`[buildTree] ${dir} => ${entries.length} entries`);
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function TreeView({ nodes, selected, onSelect }: {
  nodes: TreeNode[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="file-tree">
      {nodes.map(n => (
        <div key={n.path}>
          <div
            className={`tree-item ${n.isDir ? 'directory' : ''} ${selected === n.path ? 'active' : ''}`}
            onClick={() => n.isDir ? onSelect(n.path) : onSelect(n.path)}
          >
            <span>{n.isDir ? '📁' : '📄'}</span>
            <span>{n.name}</span>
          </div>
          {n.isDir && n.children.length > 0 && (
            <div className="tree-children">
              <TreeView nodes={n.children} selected={selected} onSelect={onSelect} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function FilesPage() {
  const { repo } = useConfigRepo();
  const params = useParams();
  const navigate = useNavigate();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [versionInfo, setVersionInfo] = useState<any>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [loading, setLoading] = useState(false);

  const refreshTree = useCallback(async () => {
    if (!repo) return;
    setLoading(true);
    console.log('[FilesPage] refreshTree start, rootFS:', !!repo.rootFS);
    try {
      const t0 = performance.now();
      const rootNodes = await buildTree(repo.rootFS.promises, '/');
      const t1 = performance.now();
      console.log(`[FilesPage] refreshTree done in ${(t1 - t0).toFixed(0)}ms, ${rootNodes.length} root entries`);
      setTree(rootNodes);
    } catch (err: any) {
      console.error('[FilesPage] refreshTree error:', err);
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => { refreshTree(); }, [refreshTree]);

  const effectivePath = (params['*'] ? `/${params['*']}` : selectedPath) || '';

  useEffect(() => {
    if (!repo || !effectivePath) return;
    console.log('[FilesPage] loading file:', effectivePath);
    const t0 = performance.now();
    repo.rootFS.promises.stat(effectivePath).then((s: any) => {
      console.log(`[FilesPage] stat(${effectivePath}) took ${(performance.now() - t0).toFixed(0)}ms, isFile=${s.isFile()}`);
      if (s.isFile()) {
        return repo.rootFS.promises.readFile(effectivePath, 'utf-8');
      }
      return null;
    }).then((text: string | null) => {
      console.log(`[FilesPage] readFile done in ${(performance.now() - t0).toFixed(0)}ms, ${text ? text.length + ' chars' : 'null'}`);
      if (text != null) {
        setContent(text);
        setOriginalContent(text);
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
      repo.rootFS.promises.readFile(vp, 'utf-8').then((v: string) => {
        setVersionInfo(JSON.parse(v));
      }).catch(() => setVersionInfo(null));
    });
  }, [repo, effectivePath]);

  const handleSelect = (path: string) => {
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    setExpanded(new Set(expanded));
    // Navigate to file path
    const relative = path.startsWith('/') ? path.slice(1) : path;
    navigate(`/files/${relative}`);
  };

  const isJson = effectivePath.endsWith('.json');

  const handleSave = async () => {
    if (!repo || !effectivePath) return;
    setSaving(true);
    setMessage('');
    try {
      // For .meta/ and other non-app files, write directly via rootFS.
      // For app config files (under /<appId>/), use setConfig for versioning.
      const appId = repo.appId;
      const isInAppDir = effectivePath.startsWith(`/${appId}/`);
      if (isInAppDir) {
        let data: unknown = content;
        if (isJson) data = JSON.parse(content);
        repo.setConfig(effectivePath.slice(`/${appId}`.length), data);
      } else {
        // Direct write (e.g. /.meta/backends.json, /shared/xxx)
        const data = isJson ? JSON.stringify(JSON.parse(content), null, 2) : content;
        await repo.rootFS.promises.writeFile(effectivePath, data);
      }
      setMessage('Saved');
      setOriginalContent(content);
      refreshTree();
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

  if (!repo) return <div className="loading">No repo connected</div>;

  const hasChanges = content !== originalContent;

  return (
    <div className="split-pane">
      <div className="split-pane-left">
        {loading && <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12 }}>Loading...</div>}
        <TreeView nodes={tree} selected={selectedPath} onSelect={handleSelect} />
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