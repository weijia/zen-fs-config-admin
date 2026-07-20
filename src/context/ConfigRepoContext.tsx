import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { createConfigRepo, type IConfigRepo, type ConfigRepoOptions } from 'zen-fs-config';
import { versionDisplay, buildTimeDisplay } from '../version';

const STORAGE_KEY = 'zen-fs-config-admin:connect-params';

function saveConnectParams(appId: string, options: ConfigRepoOptions) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ appId, options })); } catch { /* ignore */ }
}

function loadConnectParams(): { appId: string; options: ConfigRepoOptions } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function clearConnectParams() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

interface ConfigRepoContextValue {
  repo: IConfigRepo | null;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  error: string | null;
  primaryBackendId: string | null;
  connect: (appId: string, options: ConfigRepoOptions) => Promise<void>;
  disconnect: () => Promise<void>;
  reconnect: () => Promise<void>;
}

const Context = createContext<ConfigRepoContextValue>({
  repo: null,
  connected: false,
  connecting: false,
  reconnecting: false,
  error: null,
  primaryBackendId: null,
  connect: async () => {},
  disconnect: async () => {},
  reconnect: async () => {},
});

async function ensureSyncPairs(repo: IConfigRepo, appId: string, options: ConfigRepoOptions): Promise<IConfigRepo> {
  const statuses = repo.getSyncStatuses();
  if (statuses.size > 0) return repo;

  try {
    const backendsMeta = await repo.getBackends();
    const syncMeta = await repo.getSyncRules();
    if (!backendsMeta || !syncMeta) return repo;

    const enabledReplicaIds = backendsMeta.backends
      .filter(b => b.id !== options.primaryBackendId && (b as any).enabled !== false)
      .map(b => b.id);
    if (enabledReplicaIds.length === 0) return repo;

    let needsRepair = syncMeta.rules.some(
      r => r.direction !== 'none' && (!r.replicas || r.replicas.length === 0)
    );

    const metaRule = syncMeta.rules.find(r => r.prefix === '/.meta/');
    if (metaRule && metaRule.direction === 'none') {
      needsRepair = true;
    }

    if (!needsRepair) return repo;

    const fixedRules = syncMeta.rules.map(rule => {
      if (rule.prefix === '/.meta/' && rule.direction === 'none') {
        return {
          ...rule,
          direction: 'one-way' as any,
          conflictStrategy: 'source-wins' as any,
          replicas: enabledReplicaIds,
        };
      }
      if (rule.direction === 'none') return rule;
      return { ...rule, replicas: rule.replicas?.length ? rule.replicas : enabledReplicaIds };
    });
    await repo.updateSyncRules({ version: 1, rules: fixedRules });
    await repo.dispose();

    const r2 = await createConfigRepo(appId, options);
    return r2;
  } catch (err) {
    return repo;
  }
}

/**
 * Walk a directory tree and return file paths matching prefix.
 */
async function walkFiles(fs: any, dir: string, prefix: string): Promise<string[]> {
  const results: string[] = [];
  const root = dir.replace(/\/$/, '') || '/';
  async function visit(d: string) {
    try {
      const entries = await fs.readdir(d);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const fullPath = d === '/' ? `/${entry}` : `${d}/${entry}`;
        const relPath = fullPath.slice(root.length) || '/';
        if (!relPath.startsWith(prefix)) {
          try {
            const stat = await fs.stat(fullPath);
            if (typeof stat.isDirectory === 'function' && stat.isDirectory()) {
              await visit(fullPath);
            }
          } catch { /* ignore */ }
          continue;
        }
        try {
          const stat = await fs.stat(fullPath);
          if (typeof stat.isDirectory === 'function' && stat.isDirectory()) {
            await visit(fullPath);
          } else if (typeof stat.isFile === 'function' ? stat.isFile() : !stat.isDirectory) {
            results.push(relPath);
          }
        } catch { /* stat failed */ }
      }
    } catch { /* readdir failed */ }
  }
  await visit(root);
  return results;
}

/**
 * Sync once and stop watching. No continuous polling.
 * Reset sourceSnapshots to force "first sync" path (source vs target comparison).
 */
async function syncOnceAndStop(repo: IConfigRepo) {
  try {
    // @ts-ignore
    const engine = repo.syncEngine;
    if (!engine) return;

    const pairsMap = (engine as any)._pairs;
    if (!pairsMap) return;

    console.log('[sync-data] === SYNC ONCE START ===');
    for (const [pairId, pair] of pairsMap.entries()) {
      console.log(`[sync-data] syncing ${pairId}...`);
      console.log(`[sync-data]   before: sourceSnapshots.size=${pair.sourceSnapshots?.size || 0}`);

      // Reset snapshots to force detector to compare source vs target (first-sync path)
      pair.sourceSnapshots = new Map();
      if (pair.options?.direction === 'bi-directional') {
        pair.targetSnapshots = new Map();
      }

      // Call pair.sync() directly and await (engine.sync() does NOT await pair.sync())
      const result = await pair.sync();
      console.log(`[sync-data]   after: sourceSnapshots.size=${pair.sourceSnapshots?.size || 0}`);
      console.log(`[sync-data]   result:`, JSON.stringify({
        filesCreated: result?.filesCreated,
        filesUpdated: result?.filesUpdated,
        filesDeleted: result?.filesDeleted,
        filesSkipped: result?.filesSkipped,
        changes: result?.changes?.length,
        durationMs: result?.durationMs,
      }));
    }
    console.log('[sync-data] === SYNC ONCE DONE ===');

    // Stop all watches to disable continuous polling
    for (const pairId of engine.listPairs()) {
      try { engine.unwatch(pairId); } catch { /* may not be watching */ }
    }
    console.log('[sync-data] all watches stopped — manual sync only');
  } catch (err) {
    console.error('[sync-data] syncOnceAndStop error:', err);
  }
}

/**
 * Attach verbose sync logging: file lists, readFile, writeFile, sync results.
 * Also wraps pair.sync() to log detector internals.
 */
function attachSyncDataLogger(repo: IConfigRepo) {
  // @ts-ignore
  const engine = repo.syncEngine;
  if (!engine) return;

  const pairIds: string[] = engine.listPairs ? engine.listPairs() : [];
  const pairsMap = (engine as any)._pairs;

  for (const pairId of pairIds) {
    const pair = pairsMap?.get?.(pairId);
    if (!pair) continue;
    const prefix = pair.options?.filter?.includePrefixes?.[0] || '/';

    // Log pair setup
    console.log(`[sync-data] pair: ${pairId} prefix=${prefix} dir=${pair.options?.direction} root=${pair.root}`);

    // Wrap pair.sync() to log detector state
    const origSync = pair.sync;
    pair.sync = async () => {
      console.log(`[sync-data] pair.sync() START ${pairId}`);
      console.log(`[sync-data]   sourceSnapshots.size=${pair.sourceSnapshots?.size || 0} targetSnapshots.size=${pair.targetSnapshots?.size || 0}`);
      try {
        const result = await origSync();
        console.log(`[sync-data] pair.sync() DONE ${pairId}`, JSON.stringify({
          filesCreated: result?.filesCreated,
          filesUpdated: result?.filesUpdated,
          filesDeleted: result?.filesDeleted,
          changes: result?.changes?.length,
          durationMs: result?.durationMs,
        }));
        return result;
      } catch (err: any) {
        console.error(`[sync-data] pair.sync() ERROR ${pairId}:`, err.message || err);
        throw err;
      }
    };

    // Wrap writeFile to log every write operation
    const origWrite = pair.target.writeFile;
    pair.target.writeFile = async (path: string, content: string | Uint8Array) => {
      const len = typeof content === 'string' ? content.length : content?.byteLength || 0;
      console.log(`[sync-data] WRITE → target:${pairId} ${path} (${len} bytes)`);
      try {
        const result = await origWrite(path, content);
        console.log(`[sync-data] WRITE OK → target:${pairId} ${path}`);
        return result;
      } catch (err: any) {
        console.error(`[sync-data] WRITE FAIL → target:${pairId} ${path}:`, err.message || err);
        throw err;
      }
    };

    // Wrap readFile to log every read operation
    const origRead = pair.source.readFile;
    pair.source.readFile = async (path: string, encoding?: string) => {
      console.log(`[sync-data] READ  ← source:${pairId} ${path}`);
      try {
        const content = await origRead(path, encoding);
        const len = typeof content === 'string' ? content.length : content?.byteLength || 0;
        console.log(`[sync-data] READ  OK ← source:${pairId} ${path} (${len} bytes)`);
        return content;
      } catch (err: any) {
        console.error(`[sync-data] READ  FAIL ← source:${pairId} ${path}:`, err.message || err);
        throw err;
      }
    };

    // sync:start: print source/target file lists
    engine.on(pairId, 'sync:start', (e: any) => {
      (async () => {
        try {
          const [srcFiles, tgtFiles] = await Promise.all([
            walkFiles(pair.source, pair.root, prefix),
            walkFiles(pair.target, pair.root, prefix),
          ]);
          console.log(`[sync-data] sync:start ${e.pairId} src=${srcFiles.length} tgt=${tgtFiles.length}`);
          console.log(`[sync-data]   source files: [${srcFiles.join(', ')}]`);
          console.log(`[sync-data]   target files: [${tgtFiles.join(', ')}]`);
        } catch (err) {
          console.error(`[sync-data] sync:start file list error ${e.pairId}:`, err);
        }
      })();
    });

    // sync:end: print result summary
    engine.on(pairId, 'sync:end', (e: any) => {
      const r = e.result;
      console.log(`[sync-data] sync:end ${e.pairId} +${r.filesCreated}/~${r.filesUpdated}/-${r.filesDeleted} skip:${r.filesSkipped} changes:${r.changes?.length || 0} ${r.durationMs}ms`);
      if (r.changes?.length) {
        r.changes.forEach((c: any) => {
          console.log(`[sync-data]   CHANGE: ${c.type} ${c.path}`);
        });
      }
      if (r.filesSkipped > 0) {
        console.warn(`[sync-data] WARNING: ${r.filesSkipped} files skipped (write failed)`);
      }
    });

    engine.on(pairId, 'sync:error', (e: any) => {
      console.error(`[sync-data] sync:error ${e.pairId}:`, e.error);
    });
    engine.on(pairId, 'conflict', (e: any) => {
      console.warn(`[sync-data] conflict ${e.pairId}:`, e.conflict?.path);
    });
  }
}

export function ConfigRepoProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<IConfigRepo | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [primaryBackendId, setPrimaryBackendId] = useState<string | null>(null);
  const connectParamsRef = useRef<{ appId: string; options: ConfigRepoOptions } | null>(null);

  const doConnect = useCallback(async (appId: string, options: ConfigRepoOptions) => {
    setConnecting(true);
    setError(null);
    try {
      let r = await createConfigRepo(appId, options);
      r = await ensureSyncPairs(r, appId, options);
      connectParamsRef.current = { appId, options };
      saveConnectParams(appId, options);
      setRepo(r);
      setConnected(true);
      setPrimaryBackendId(options.primaryBackendId);
      attachSyncDataLogger(r);
      await syncOnceAndStop(r);
      console.log('[version] connected:', versionDisplay, '| build:', buildTimeDisplay);
    } catch (err: any) {
      setError(err.message || String(err));
      throw err;
    } finally {
      setConnecting(false);
    }
  }, []);

  const connect = useCallback(async (appId: string, options: ConfigRepoOptions) => {
    await doConnect(appId, options);
  }, [doConnect]);

  const disconnect = useCallback(async () => {
    if (repo) await repo.dispose();
    setRepo(null);
    setConnected(false);
    setError(null);
    setPrimaryBackendId(null);
    connectParamsRef.current = null;
    clearConnectParams();
  }, [repo]);

  const reconnect = useCallback(async () => {
    const params = connectParamsRef.current;
    if (!params) return;
    setReconnecting(true);
    try {
      if (repo) await repo.dispose();
      let r = await createConfigRepo(params.appId, params.options);
      r = await ensureSyncPairs(r, params.appId, params.options);
      setRepo(r);
      attachSyncDataLogger(r);
      await syncOnceAndStop(r);
      console.log('[version] reconnected:', versionDisplay, '| build:', buildTimeDisplay);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setReconnecting(false);
    }
  }, [repo]);

  // Auto-reconnect on page refresh
  useEffect(() => {
    const saved = loadConnectParams();
    if (!saved) return;
    setConnecting(true);
    createConfigRepo(saved.appId, saved.options)
      .then(async r => {
        r = await ensureSyncPairs(r, saved.appId, saved.options);
        connectParamsRef.current = saved;
        setRepo(r);
        setConnected(true);
        setPrimaryBackendId(saved.options.primaryBackendId);
        attachSyncDataLogger(r);
        await syncOnceAndStop(r);
        console.log('[version] auto-reconnected:', versionDisplay, '| build:', buildTimeDisplay);
      })
      .catch(err => {
        console.error('[version] auto-reconnect failed:', err);
        clearConnectParams();
      })
      .finally(() => setConnecting(false));
  }, []);

  return (
    <Context.Provider value={{ repo, connected, connecting, reconnecting, error, primaryBackendId, connect, disconnect, reconnect }}>
      {children}
    </Context.Provider>
  );
}

export function useConfigRepo() {
  return useContext(Context);
}
