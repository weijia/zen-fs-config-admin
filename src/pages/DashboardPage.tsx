import { useEffect, useState, useRef } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';

export default function DashboardPage() {
  const { repo } = useConfigRepo();
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [flushResult, setFlushResult] = useState<any[]>([]);
  const [flushing, setFlushing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
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
        console.log('[sync-data]   pair:', id, 'state:', s.state, 'watching:', s.watching, 'totalSyncs:', s.totalSyncs, 'lastResult:', s.lastResult);
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
  const lastResult = pairs.find(([, s]) => s.lastResult)?.[1].lastResult;
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

      {lastResult && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-title">Last Sync Result</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Created</div>
              <div>{lastResult.filesCreated}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Updated</div>
              <div>{lastResult.filesUpdated}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Deleted</div>
              <div>{lastResult.filesDeleted}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Duration</div>
              <div>{lastResult.durationMs}ms</div>
            </div>
          </div>
        </div>
      )}

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
