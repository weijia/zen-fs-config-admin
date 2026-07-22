import { useEffect, useState, useRef } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';

export default function DashboardPage() {
  const { repo } = useConfigRepo();
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [flushResult, setFlushResult] = useState<any[]>([]);
  const [flushing, setFlushing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncingPair, setSyncingPair] = useState<string | null>(null);
  const [diagResult, setDiagResult] = useState<any>(null);
  const [diagRunning, setDiagRunning] = useState(false);
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

  /**
   * Full diagnostic: for each sync pair, directly walk source and target
   * file trees (bypassing incremental detector) and report differences.
   */
  const handleDiagnose = async () => {
    setDiagRunning(true);
    setDiagResult(null);
    try {
      // @ts-ignore
      const engine = repo?.syncEngine;
      if (!engine) {
        setDiagResult({ error: 'No sync engine available' });
        return;
      }
      const pairsMap = (engine as any).pairs || (engine as any)._pairs;
      if (!pairsMap) {
        setDiagResult({ error: 'Cannot access internal pairs map' });
        return;
      }

      const results: any[] = [];
      for (const [pairId, pair] of pairsMap.entries()) {
        const prefix = pair.options?.filter?.includePrefixes?.[0] || '/';
        const direction = pair.options?.direction;
        const root = pair.root || '/';

        console.log(`[diag] pair=${pairId} prefix=${prefix} dir=${direction} root=${root}`);

        // Walk source
        const srcFiles: string[] = [];
        await walkAndCollect(pair.source, root, prefix, srcFiles);
        console.log(`[diag] ${pairId} source files (${srcFiles.length}):`, srcFiles);

        // Walk target
        const tgtFiles: string[] = [];
        await walkAndCollect(pair.target, root, prefix, tgtFiles);
        console.log(`[diag] ${pairId} target files (${tgtFiles.length}):`, tgtFiles);

        const inSrcNotTgt = srcFiles.filter(f => !tgtFiles.includes(f));
        const inTgtNotSrc = tgtFiles.filter(f => !srcFiles.includes(f));

        console.log(`[diag] ${pairId} inSourceNotTarget (${inSrcNotTgt.length}):`, inSrcNotTgt);
        console.log(`[diag] ${pairId} inTargetNotSource (${inTgtNotSrc.length}):`, inTgtNotSrc);

        results.push({
          pairId,
          prefix,
          direction: String(direction),
          sourceCount: srcFiles.length,
          targetCount: tgtFiles.length,
          sourceFiles: srcFiles,
          targetFiles: tgtFiles,
          inSourceNotTarget: inSrcNotTgt,
          inTargetNotSource: inTgtNotSrc,
        });
      }

      setDiagResult({ pairs: results });
    } catch (err) {
      console.error('[diag] failed:', err);
      setDiagResult({ error: String(err) });
    } finally {
      setDiagRunning(false);
    }
  };

  /**
   * Force full sync: reset sourceSnapshots to empty so next detect()
   * compares source vs target (not source vs source-prev).
   */
  const handleForceFullSync = async () => {
    setDiagRunning(true);
    try {
      // @ts-ignore
      const engine = repo?.syncEngine;
      if (!engine) return;
      const pairsMap = (engine as any).pairs || (engine as any)._pairs;
      if (!pairsMap) return;

      for (const [pairId, pair] of pairsMap.entries()) {
        console.log(`[diag] force full sync: ${pairId} - resetting sourceSnapshots`);
        pair.sourceSnapshots = new Map();
        const result = await engine.sync(pairId);
        console.log(`[diag] force full sync done: ${pairId}`, result);
      }
      setRefreshKey(k => k + 1);
    } catch (err) {
      console.error('[diag] force full sync failed:', err);
    } finally {
      setDiagRunning(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={handleDiagnose} disabled={diagRunning}>
            {diagRunning ? 'Running...' : 'Diagnose'}
          </button>
          <button className="btn btn-secondary" onClick={handleForceFullSync} disabled={diagRunning}>
            Force Full Sync
          </button>
          <button className="btn btn-primary" onClick={handleFlush} disabled={flushing}>
            {flushing ? 'Syncing...' : 'Flush All'}
          </button>
        </div>
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

      {/* Diagnostic Results */}
      {diagResult && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-title">Diagnostic Results</div>
          {diagResult.error && (
            <div style={{ color: 'var(--danger)' }}>{diagResult.error}</div>
          )}
          {diagResult.pairs?.map((p: any, i: number) => (
            <div key={i} style={{ marginBottom: 16, padding: 12, background: 'var(--bg-secondary)', borderRadius: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <span className="badge badge-primary">{p.pairId}</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    prefix={p.prefix} dir={p.direction}
                  </span>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, fontSize: 12 }}>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Source Files ({p.sourceCount})</div>
                  <div style={{ fontFamily: 'var(--font-mono)', maxHeight: 150, overflow: 'auto' }}>
                    {p.sourceFiles.length === 0 ? '(empty)' : p.sourceFiles.map((f: string, j: number) => <div key={j}>{f}</div>)}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)' }}>Target Files ({p.targetCount})</div>
                  <div style={{ fontFamily: 'var(--font-mono)', maxHeight: 150, overflow: 'auto' }}>
                    {p.targetFiles.length === 0 ? '(empty)' : p.targetFiles.map((f: string, j: number) => <div key={j}>{f}</div>)}
                  </div>
                </div>
                <div>
                  <div style={{ color: p.inSourceNotTarget.length ? 'var(--danger)' : 'var(--text-muted)' }}>
                    In Source, NOT in Target ({p.inSourceNotTarget.length})
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', maxHeight: 150, overflow: 'auto' }}>
                    {p.inSourceNotTarget.length === 0 ? '(none)' : p.inSourceNotTarget.map((f: string, j: number) => <div key={j} style={{ color: 'var(--danger)' }}>{f}</div>)}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sync Pairs Detail */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title">Sync Pairs Detail</div>
        {pairs.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No sync pairs configured</div>
        )}
        {pairs.map(([id, s]) => {
          const r = s.lastResult;
          const statusColor = s.state === 'syncing' ? 'var(--warning)'
            : s.state === 'error' ? 'var(--danger)'
            : r && r.filesSkipped > 0 ? 'var(--warning)'
            : 'var(--success)';
          const statusText = s.state === 'syncing' ? 'Syncing...'
            : s.state === 'error' ? 'Error'
            : !r ? 'Not synced yet'
            : `Last: +${r.filesCreated}/~${r.filesUpdated}/-${r.filesDeleted} in ${r.durationMs}ms`;

          return (
            <div key={id} style={{ marginBottom: 12, padding: 12, background: 'var(--bg-secondary)', borderRadius: 6, borderLeft: `3px solid ${statusColor}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <span className="badge badge-primary">{id}</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: statusColor, fontWeight: 600 }}>
                    {statusText}
                  </span>
                  {s.watching && <span className="badge" style={{ marginLeft: 8, background: 'var(--info)', color: '#fff' }}>watch</span>}
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
                  <div style={{ color: 'var(--text-muted)' }}>Conflicts</div>
                  <div style={{ color: r?.conflicts?.length ? 'var(--danger)' : 'inherit' }}>{r?.conflicts?.length ?? '-'}</div>
                </div>
              </div>
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

/**
 * Walk a directory tree recursively and collect file paths relative to root.
 */
async function walkAndCollect(fs: any, root: string, prefix: string, results: string[]): Promise<void> {
  const rootNormalized = root.replace(/\/$/, '') || '/';
  async function visit(dir: string) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
      const relPath = fullPath.slice(rootNormalized.length) || '/';
      if (!relPath.startsWith(prefix)) {
        // Check if it's a directory that might contain matching files
        try {
          const stat = await fs.stat(fullPath);
          if (stat.mode !== undefined && (stat.mode & 0o40000) === 0o40000) {
            await visit(fullPath);
          }
        } catch { /* ignore */ }
        continue;
      }
      try {
        const stat = await fs.stat(fullPath);
        if (stat.mode !== undefined && (stat.mode & 0o40000) === 0o40000) {
          await visit(fullPath);
        } else {
          results.push(relPath);
        }
      } catch { /* stat failed */ }
    }
  }
  await visit(rootNormalized);
}
