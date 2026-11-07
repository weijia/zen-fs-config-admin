import { useState, useEffect, useCallback } from 'react';
import { useSyncTarget } from '../context/SyncTargetContext';
import { targetKindLabel } from '../sync-target';
import type { ConflictArchive } from 'zen-fs-config';

export default function ConflictsPage() {
  const { conflicts: reader, ready, selected: target, selectedOption } = useSyncTarget();
  const [conflicts, setConflicts] = useState<ConflictArchive[]>([]);
  const [selected, setSelected] = useState<ConflictArchive | null>(null);
  const [sourceContent, setSourceContent] = useState<string>('');
  const [targetContent, setTargetContent] = useState<string>('');
  const [resolvedContent, setResolvedContent] = useState<string>('');
  const [mergeText, setMergeText] = useState('');
  const [message, setMessage] = useState('');
  const [loadingBackup, setLoadingBackup] = useState(false);

  const loadConflicts = useCallback(async () => {
    if (!reader) return;
    try { const list = await reader.listConflicts(); setConflicts(list); } catch { /* ignore */ }
  }, [reader]);

  // 切换 target 后清空并重新读取该组的冲突存档。
  useEffect(() => {
    setConflicts([]);
    setSelected(null);
    loadConflicts();
  }, [loadConflicts]);

  const loadConflictBackups = useCallback(async (c: ConflictArchive) => {
    if (!reader || !c.sourceBackupPath) return;
    setLoadingBackup(true);
    try {
      const conflictId = getConflictId(c);
      const [src, tgt] = await Promise.all([
        reader.readConflictBackup(conflictId, 'source').catch(() => '(failed to load)'),
        reader.readConflictBackup(conflictId, 'target').catch(() => '(failed to load)'),
      ]);
      setSourceContent(src);
      setTargetContent(tgt);

      if (c.resolvedBackupPath) {
        const res = await reader.readConflictBackup(conflictId, 'resolved').catch(() => '');
        setResolvedContent(res);
      } else {
        setResolvedContent('');
        // Default merge text to source content
        setMergeText(src);
      }
    } finally {
      setLoadingBackup(false);
    }
  }, [reader]);

  useEffect(() => {
    if (selected) loadConflictBackups(selected);
  }, [selected, loadConflictBackups]);

  const getConflictId = (c: ConflictArchive) =>
    `${c.timestamp}_${c.conflictPath.replace(/\//g, '_')}/meta.json`;

  const handleResolve = async () => {
    if (!reader || !selected) return;
    try {
      let data: unknown;
      try { data = JSON.parse(mergeText); } catch { data = mergeText; }
      await reader.resolveConflict(getConflictId(selected), data);
      setMessage('Resolved'); setSelected(null); await loadConflicts();
    } catch (err: any) { setMessage(`Error: ${err.message}`); }
    setTimeout(() => setMessage(''), 3000);
  };

  if (!ready) {
    return (
      <div>
        <div className="page-header">
          <h1 className="title">Conflicts</h1>
        </div>
        <div className="empty-state">
          <p>{selectedOption?.label ?? `${target.appId} / ${target.groupId ?? ''}`} 尚未打开</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            冲突存档跟随当前选中的同步组；组打开后这里会显示该组的冲突。
          </p>
        </div>
      </div>
    );
  }
  const unresolved = conflicts.filter(c => !c.resolvedBackupPath);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="title">Conflicts</h1>
          <p className="form-hint" style={{ marginTop: 2 }}>
            <span className={`badge ${target.kind === 'config' ? 'badge-primary' : 'badge-success'}`} style={{ marginRight: 6 }}>
              {targetKindLabel(target)}
            </span>
            {selectedOption?.label ?? selectedKeyFallback(target)} · {target.appId}
          </p>
        </div>
        <span className="badge badge-warning">{unresolved.length} unresolved</span>
      </div>
      {message && <div style={{ marginBottom: 16, color: message.includes('Error') ? 'var(--danger)' : 'var(--success)', fontSize: 13 }}>{message}</div>}

      <div className="table-wrapper" style={{ marginBottom: selected ? 16 : 0 }}>
        <table>
          <thead><tr><th>Time</th><th>Path</th><th>Source</th><th>Target</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {conflicts.map((c, i) => {
              const isResolved = !!c.resolvedBackupPath;
              return (
                <tr key={i} style={{ opacity: isResolved ? 0.5 : 1 }}>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(c.timestamp).toLocaleString()}</td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{c.conflictPath}</td>
                  <td>{c.sourceAuthor}</td>
                  <td>{c.targetAuthor}</td>
                  <td>
                    {isResolved
                      ? <span className="badge badge-primary">resolved</span>
                      : <span className="badge badge-warning">{c.resolvedStrategy ?? 'pending'}</span>
                    }
                  </td>
                  <td>
                    <button className="btn btn-sm btn-secondary" onClick={() => setSelected(c)}>View</button>
                    {!isResolved && <button className="btn btn-sm btn-primary" onClick={() => setSelected(c)} style={{ marginLeft: 4 }}>Resolve</button>}
                  </td>
                </tr>
              );
            })}
            {conflicts.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No conflicts</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 800 }}>
            <div className="modal-title">{selected.conflictPath}</div>
            {loadingBackup ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading conflict files...</div>
            ) : (
              <>
                <div className="diff-container">
                  <div className="diff-pane">
                    <div className="diff-pane-title">Source (v{selected.sourceVersion}) — {selected.sourceAuthor}</div>
                    <pre>{sourceContent}</pre>
                  </div>
                  <div className="diff-pane">
                    <div className="diff-pane-title">Target (v{selected.targetVersion}) — {selected.targetAuthor}</div>
                    <pre>{targetContent}</pre>
                  </div>
                </div>
                {!!resolvedContent && (
                  <div style={{ marginTop: 12 }}>
                    <div className="diff-pane-title">Resolved</div>
                    <pre style={{ background: 'var(--bg-tertiary)', padding: 12, borderRadius: 6, maxHeight: 200, overflow: 'auto' }}>{resolvedContent}</pre>
                  </div>
                )}
                {!selected.resolvedBackupPath && (
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
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function selectedKeyFallback(ref: { kind: string; appId: string; groupId: string | null }): string {
  return ref.kind === 'config' ? `${ref.appId} 配置组` : `${ref.appId} / ${ref.groupId}`;
}
