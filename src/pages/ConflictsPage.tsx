import { useState, useEffect, useCallback } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { ConflictArchive } from 'zen-fs-config';

export default function ConflictsPage() {
  const { repo } = useConfigRepo();
  const [conflicts, setConflicts] = useState<ConflictArchive[]>([]);
  const [selected, setSelected] = useState<ConflictArchive | null>(null);
  const [mergeText, setMergeText] = useState('');
  const [message, setMessage] = useState('');

  const loadConflicts = useCallback(async () => {
    if (!repo) return;
    try { const list = await repo.listConflicts(); setConflicts(list); } catch { /* ignore */ }
  }, [repo]);

  useEffect(() => { loadConflicts(); }, [loadConflicts]);

  useEffect(() => {
    if (selected) {
      setMergeText(typeof selected.resolvedContent === 'string'
        ? selected.resolvedContent
        : JSON.stringify(selected.resolvedContent ?? selected.sourceContent, null, 2));
    }
  }, [selected]);

  const getConflictId = (c: ConflictArchive) =>
    `${c.timestamp}_${c.conflictPath.replace(/\//g, '_')}.conflict.json`;

  const handleResolve = async () => {
    if (!repo || !selected) return;
    try {
      let data: unknown;
      try { data = JSON.parse(mergeText); } catch { data = mergeText; }
      await repo.resolveConflict(getConflictId(selected), data);
      setMessage('Resolved'); setSelected(null); await loadConflicts();
    } catch (err: any) { setMessage(`Error: ${err.message}`); }
    setTimeout(() => setMessage(''), 3000);
  };

  if (!repo) return <div className="loading">No repo connected</div>;
  const unresolved = conflicts.filter(c => !c.resolvedContent);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Conflicts</h1>
        <span className="badge badge-warning">{unresolved.length} unresolved</span>
      </div>
      {message && <div style={{ marginBottom: 16, color: message.includes('Error') ? 'var(--danger)' : 'var(--success)', fontSize: 13 }}>{message}</div>}

      <div className="table-wrapper" style={{ marginBottom: selected ? 16 : 0 }}>
        <table>
          <thead><tr><th>Time</th><th>Path</th><th>Source</th><th>Target</th><th>Strategy</th><th>Actions</th></tr></thead>
          <tbody>
            {conflicts.map((c, i) => (
              <tr key={i} style={{ opacity: c.resolvedContent ? 0.5 : 1 }}>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(c.timestamp).toLocaleString()}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{c.conflictPath}</td>
                <td>{c.sourceAuthor}</td>
                <td>{c.targetAuthor}</td>
                <td><span className="badge badge-warning">{c.resolvedStrategy ?? 'auto'}</span></td>
                <td>
                  <button className="btn btn-sm btn-secondary" onClick={() => setSelected(c)}>View</button>
                  {!c.resolvedContent && <button className="btn btn-sm btn-primary" onClick={() => setSelected(c)} style={{ marginLeft: 4 }}>Resolve</button>}
                </td>
              </tr>
            ))}
            {conflicts.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No conflicts</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 800 }}>
            <div className="modal-title">{selected.conflictPath}</div>
            <div className="diff-container">
              <div className="diff-pane">
                <div className="diff-pane-title">Source (v{selected.sourceVersion}) — {selected.sourceAuthor}</div>
                <pre>{typeof selected.sourceContent === 'string' ? selected.sourceContent : JSON.stringify(selected.sourceContent, null, 2)}</pre>
              </div>
              <div className="diff-pane">
                <div className="diff-pane-title">Target (v{selected.targetVersion}) — {selected.targetAuthor}</div>
                <pre>{typeof selected.targetContent === 'string' ? selected.targetContent : JSON.stringify(selected.targetContent, null, 2)}</pre>
              </div>
            </div>
            {!selected.resolvedContent && (
              <>
                <div style={{ marginTop: 16 }}>
                  <label className="form-label">Merged Result</label>
                  <textarea className="editor-textarea" rows={8} value={mergeText} onChange={e => setMergeText(e.target.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, height: 200 }} />
                </div>
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setSelected(null)}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleResolve}>Save Resolution</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}