import { useState, useEffect, useCallback } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';

interface NodeInfo {
  id: string;
  files: string[];
}

export default function NodesPage() {
  const { repo } = useConfigRepo();
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [nodeFiles, setNodeFiles] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState('');

  const loadNodes = useCallback(async () => {
    if (!repo) return;
    try {
      const entries = await repo.fs.promises.readdir('/nodes');
      const nodeInfos: NodeInfo[] = [];
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const nodePath = `/nodes/${entry}`;
        const stat = await repo.fs.promises.stat(nodePath);
        if (stat.isDirectory()) {
          const files = await listFiles(repo.fs.promises, nodePath);
          nodeInfos.push({ id: entry, files });
        }
      }
      setNodes(nodeInfos);
    } catch { /* /nodes/ doesn't exist */ }
  }, [repo]);

  useEffect(() => { loadNodes(); }, [loadNodes]);

  useEffect(() => {
    if (selectedNode) {
      const node = nodes.find(n => n.id === selectedNode);
      setNodeFiles(node?.files ?? []);
      setFileContent('');
    }
  }, [selectedNode, nodes]);

  const handleViewFile = async (filePath: string) => {
    if (!repo) return;
    try {
      const raw = await repo.fs.promises.readFile(filePath, 'utf-8');
      setFileContent(raw);
    } catch (err: any) {
      setFileContent(`Error: ${err.message}`);
    }
  };

  const handlePublish = async () => {
    if (!repo || !selectedNode) return;
    setPublishing(true);
    setMessage('');
    try {
      const result = await repo.publishNodeConfig(selectedNode);
      setMessage(`Published: +${result.filesCreated} ~${result.filesUpdated}`);
      await loadNodes();
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setPublishing(false);
      setTimeout(() => setMessage(''), 5000);
    }
  };

  if (!repo) return <div className="loading">No repo connected</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Nodes</h1>
      </div>

      {message && <div style={{ marginBottom: 16, color: message.includes('Error') ? 'var(--danger)' : 'var(--success)', fontSize: 13 }}>{message}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '200px 200px 1fr', gap: 16 }}>
        {/* Node list */}
        <div className="card">
          <div className="card-title">Nodes</div>
          {nodes.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No nodes found</p>}
          {nodes.map(n => (
            <div
              key={n.id}
              className={`tree-item ${selectedNode === n.id ? 'active' : ''}`}
              onClick={() => setSelectedNode(n.id)}
            >
              <span>◉</span>
              <span>{n.id}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{n.files.length}</span>
            </div>
          ))}
        </div>

        {/* File list */}
        <div className="card">
          <div className="card-title">
            Files
            {selectedNode && (
              <button
                className="btn btn-sm btn-primary"
                style={{ float: 'right' }}
                onClick={handlePublish}
                disabled={publishing}
              >
                {publishing ? 'Publishing...' : 'Publish'}
              </button>
            )}
          </div>
          {nodeFiles.map(f => {
            const name = f.split('/').pop()!;
            return (
              <div
                key={f}
                className="tree-item"
                onClick={() => handleViewFile(f)}
              >
                <span>📄</span>
                <span>{name}</span>
              </div>
            );
          })}
          {nodeFiles.length === 0 && selectedNode && (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No files</p>
          )}
        </div>

        {/* File content */}
        <div className="card">
          <div className="card-title">Content</div>
          {fileContent ? (
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>
              {fileContent}
            </pre>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Select a file to view</p>
          )}
        </div>
      </div>
    </div>
  );
}

async function listFiles(fs: any, dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          results.push(...await listFiles(fs, fullPath));
        } else {
          results.push(fullPath);
        }
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }
  return results;
}