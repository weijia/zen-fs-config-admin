import { useEffect, useState, useRef } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';

export default function DashboardPage() {
  const { repo } = useConfigRepo();
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [flushResult, setFlushResult] = useState<any[]>([]);
  const [flushing, setFlushing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncingPair, setSyncingPair] = useState<string | null>(null);
  const prevTotalSyncsRef = useRef(0);

  useEffect(() => {
    if (!repo) return;
    const timer = setInterval(() => setRefreshKey(k => k + 1), 3000);
    return () => clearInterval(timer);
  }, [repo]);

  useEffect(() => {
    if (!repo) return;
    repo.listConflicts().then(setConflicts).catch(() => {});
  }, [repo, refreshKey]);

  // Log sync status changes every 3s
  useEffect(() => {
    if (!repo) return;
    const statuses = repo.getSyncStatuses();
    const pairs = Array.from(statuses.entries());
    const totalSyncs = pairs.reduce((sum, [, s]) => sum + s.totalSyncs, 0);

    if (totalSyncs !== prevTotalSyncsRef.current) {
      console.log('[sync-data] status tick — totalSyncs:', totalSyncs, 'pairs:', pairs.length);
      pairs.forEach(([id, s]) => {
        const r = s.lastResult;
        console.log('[sync-data]   pair:', id,
          'state:', s.state,
          'watching:', s.watching,
          'totalSyncs:', s.totalSyncs,
          r ? `last: +${r.filesCreated}/~${r.filesUpdated}/-${r.filesDeleted} skip:${r.filesSkipped} changes:${r.changes?.length || 0}` : 'no lastResult'
        );
      });
      prevTotalSyncsRef.current = totalSyncs;
    }
  }, [repo, refreshKey]);

  if (!repo) return <div className="loading">No repo connected</div>;

  const statuses = repo.getSyncStatuses();
  const pairs = Array.from(statuses.entries());
  const watching = pairs.filter(([, s]) => s.watching).length;
  const idle = pairs.filter(([, s]) => s.state === 'idle').length;
  const totalSyncs = pairs.reduce((sum, [, s]) => sum + s.totalSyncs, 0);
  const unresolvedConflicts = conflicts.filter(c => !c.resolvedContent);

  const handleFlush = async () => {
    setFlushing(true);
    try {
      console.log('[sync-data] flush start');
      const results = await repo.flush();
      console.log('[sync-data] flush done, results:', JSON.stringify(results));
      setFlushResult(results);
    } catch (err) {
      console.error('[sync-data] flush failed:', err);
    } finally {
      setFlushing(false);
    }
  };

  const handleSyncPair = async (pairId: string) => {
    // @ts-ignore
    const engine = repo?.syncEngine;
    if (!engine) return;
    setSyncingPair(pairId);
    try {
      console.log('[sync-data] manual sync start:', pairId);
      const result = await engine.sync(pairId);
      console.log('[sync-data] manual sync done:', pairId, result);
    } catch (err) {
      console.error('[sync-data] manual sync failed:', pairId, err);
    } finally {
      setSyncingPair(null);
      setRefreshKey(k => k + 1);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <button className="btn btn-primary" onClick={handleFlush} disabled={flushing}>
          {flushing ? 'Syncing...' : 'Flush All'}
        </button>
      </div>

      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="card-title">Sync Pairs</div>
          <div className="stat-value">{pairs.length}</div>
          <div className="stat-label">{watching} watching, {idle} idle</div>
        </div>
        <div className="card">
          <div className="card-title">Total Syncs</div>
          <div className="stat-value">{totalSyncs}</div>
        </div>
        <div className="card">
          <div className="card-title">Conflicts</div>
          <div className="stat-value" style={{ color: unresolvedConflicts.length ? 'var(--warning)' : 'var(--success)' }}>
            {unresolvedConflicts.length}
          </div>
          <div className="stat-label">{conflicts.length} total</div>
        </div>
        <div className="card">
          <div className="card-title">Node ID</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>
            {repo.nodeId}
          </div>
        </div>
      </div>

      {/* Sync Pairs Detail */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title">Sync Pairs Detail</div>
        {pairs.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No sync pairs configured</div>
        )}
        {pairs.map(([id, s]) => {
          const r = s.lastResult;
          return (
            <div key={id} style={{ marginBottom: 12, padding: 12, background: 'var(--bg-secondary)', borderRadius: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <span className="badge badge-primary">{id}</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    {s.state} {s.watching ? '(watching)' : ''}
                  </span>
                </div>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleSyncPair(id)}
                  disabled={syncingPair === id || s.state === 'syncing'}
                >
                  {syncingPair === id ? 'Syncing...' : 'Sync Now'}
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, fontSize: 12 }}>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Total Syncs</div>
                  <div>{s.totalSyncs}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Created</div>
                  <div style={{ color: r?.filesCreated ? 'var(--success)' : 'inherit' }}>{r?.filesCreated ?? '-'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Updated</div>
                  <div style={{ color: r?.filesUpdated ? 'var(--warning)' : 'inherit' }}>{r?.filesUpdated ?? '-'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Deleted</div>
                  <div style={{ color: r?.filesDeleted ? 'var(--danger)' : 'inherit' }}>{r?.filesDeleted ?? '-'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Skipped</div>
                  <div style={{ color: r?.filesSkipped ? 'var(--danger)' : 'inherit' }}>{r?.filesSkipped ?? '-'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Changes</div>
                  <div>{r?.changes?.length ?? '-'}</div>
                </div>
              </div>
              {r && r.changes && r.changes.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                  {r.changes.slice(0, 5).map((c: any, i: number) => (
                    <div key={i}>{c.type}: {c.path}</div>
                  ))}
                  {r.changes.length > 5 && <div>... and {r.changes.length - 5} more</div>}
                </div>
              )}
              {r?.durationMs && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                  Last sync: {r.durationMs}ms
                </div>
              )}
            </div>
          );
        })}
      </div>

      {flushResult.length > 0 && (
        <div className="card">
          <div className="card-title">Flush Results</div>
          {flushResult.map((r: any, i: number) => (
            <div key={i} style={{ marginBottom: 8, fontSize: 13 }}>
              <span className="badge badge-primary">{r.pairId}</span>
              {' '}+{r.filesCreated} ~{r.filesUpdated} -{r.filesDeleted} {' '}
              <span style={{ color: 'var(--text-muted)' }}>{r.durationMs}ms</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
