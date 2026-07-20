import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { createConfigRepo, type IConfigRepo, type ConfigRepoOptions } from 'zen-fs-config';
import { setDebug } from 'zen-fs-sync';
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
 * Enable zen-fs-sync debug logging before syncing.
 */
async function syncOnceAndStop(repo: IConfigRepo) {
  try {
    // Enable debug logging (tag-based, only 'sync' and 'detector')
    setDebug('sync,detector');

    // @ts-ignore
    const engine = repo.syncEngine;
    if (!engine) return;

    const pairsMap = (engine as any)._pairs;
    if (!pairsMap) return;

    console.log('[sync-data] === SYNC ONCE START ===');
    for (const [pairId, pair] of pairsMap.entries()) {
      const prefix = pair.options?.filter?.includePrefixes?.[0] || '/';
      const root = pair.root || '/';

      console.log(`[sync-data] syncing ${pairId} ...`);
      console.log(`[sync-data]   pair: prefix=${prefix} dir=${pair.options?.direction} root=${root}`);

      // Walk source and target files directly (before sync)
      let srcFiles: string[] = [];
      let tgtFiles: string[] = [];
      try {
        [srcFiles, tgtFiles] = await Promise.all([
          walkFiles(pair.source, root, prefix),
          walkFiles(pair.target, root, prefix),
        ]);
      } catch (err: any) {
        console.error(`[sync-data]   walk error:`, err.message || err);
      }
      console.log(`[sync-data]   source files (${srcFiles.length}): [${srcFiles.join(', ')}]`);
      console.log(`[sync-data]   target files (${tgtFiles.length}): [${tgtFiles.join(', ')}]`);

      // Reset snapshots to force detector to compare source vs target (first-sync path)
      console.log(`[sync-data]   resetting sourceSnapshots (was ${pair.sourceSnapshots?.size || 0} entries)`);
      pair.sourceSnapshots = new Map();
      if (pair.options?.direction === 'bi-directional') {
        pair.targetSnapshots = new Map();
      }

      // Call pair.sync() directly and await
      const result = await pair.sync();
      console.log(`[sync-data]   sync result: +${result?.filesCreated}/~${result?.filesUpdated}/-${result?.filesDeleted} skip:${result?.filesSkipped} changes:${result?.changes?.length || 0} ${result?.durationMs || '?'}ms`);
      if (result?.changes?.length) {
        result.changes.forEach((c: any) => {
          console.log(`[sync-data]     CHANGE: ${c.type} ${c.path}`);
        });
      }
      if (result?.filesSkipped > 0) {
        console.warn(`[sync-data]     WARNING: ${result.filesSkipped} files skipped`);
      }
    }
    console.log('[sync-data] === SYNC ONCE DONE ===');

    // Disable debug logging after sync
    setDebug(false);

    // Stop all watches to disable continuous polling
    for (const pairId of engine.listPairs()) {
      try { engine.unwatch(pairId); } catch { /* may not be watching */ }
    }
    console.log('[sync-data] all watches stopped — manual sync only');
  } catch (err) {
    console.error('[sync-data] syncOnceAndStop error:', err);
    setDebug(false);
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
