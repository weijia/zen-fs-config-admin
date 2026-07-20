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

/**
 * Repair sync rules:
 * 1. Fill empty replicas for active rules
 * 2. Upgrade /.meta/ rule from 'none' to 'one-way'
 */
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
 * Walk a directory tree and return file paths relative to root.
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
        if (!relPath.startsWith(prefix)) continue;
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
 * Attach detailed sync diagnostics logging to zen-fs-sync engine.
 */
function attachSyncDataLogger(repo: IConfigRepo) {
  // @ts-ignore - syncEngine is internal but accessible
  const engine = repo.syncEngine;
  if (!engine) return;

  const pairIds: string[] = engine.listPairs ? engine.listPairs() : [];

  // Access internal pairs to get source/target/root/filter
  const pairsMap = (engine as any)._pairs;
  for (const pairId of pairIds) {
    const pair = pairsMap?.get?.(pairId);
    const prefix = pair?.options?.filter?.includePrefixes?.[0] || '/';

    engine.on(pairId, 'sync:start', (e: any) => {
      console.log(`[sync-data] sync:start ${e.pairId} ${new Date(e.timestamp).toLocaleTimeString()}`);
    });

    engine.on(pairId, 'sync:end', (e: any) => {
      const r = e.result;
      console.log(`[sync-data] sync:end ${e.pairId} +${r.filesCreated}/~${r.filesUpdated}/-${r.filesDeleted} skip:${r.filesSkipped} changes:${r.changes?.length || 0} ${r.durationMs}ms`);
      if (r.changes?.length) {
        r.changes.forEach((c: any) => {
          console.log(`[sync-data]   change: ${c.type} ${c.path}`);
        });
      }
      if (r.filesSkipped > 0) {
        console.warn(`[sync-data] sync:end ${e.pairId} WARNING: ${r.filesSkipped} files skipped (write failed)`);
      }

      // After sync, snapshot source and target to see their state
      if (pair) {
        (async () => {
          try {
            const srcFiles = await walkFiles(pair.source, pair.root, prefix);
            const tgtFiles = await walkFiles(pair.target, pair.root, prefix);
            const inSrcNotTgt = srcFiles.filter(f => !tgtFiles.includes(f));
            const inTgtNotSrc = tgtFiles.filter(f => !srcFiles.includes(f));

            console.log(`[sync-data] snapshot ${e.pairId} prefix=${prefix}`);
            console.log(`[sync-data]   source files: ${srcFiles.length}`, srcFiles.length <= 20 ? srcFiles : srcFiles.slice(0, 20).concat(['...(' + (srcFiles.length - 20) + ' more)']));
            console.log(`[sync-data]   target files: ${tgtFiles.length}`, tgtFiles.length <= 20 ? tgtFiles : tgtFiles.slice(0, 20).concat(['...(' + (tgtFiles.length - 20) + ' more)']));

            if (inSrcNotTgt.length > 0) {
              console.warn(`[sync-data]   IN SOURCE BUT NOT IN TARGET (${inSrcNotTgt.length}):`, inSrcNotTgt.slice(0, 10));
            }
            if (inTgtNotSrc.length > 0) {
              console.warn(`[sync-data]   IN TARGET BUT NOT IN SOURCE (${inTgtNotSrc.length}):`, inTgtNotSrc.slice(0, 10));
            }
          } catch (err) {
            console.error('[sync-data] snapshot error:', err);
          }
        })();
      }
    });

    engine.on(pairId, 'sync:error', (e: any) => {
      console.error(`[sync-data] sync:error ${e.pairId}`, e.error);
    });
    engine.on(pairId, 'conflict', (e: any) => {
      console.warn(`[sync-data] conflict ${e.pairId}`, e.conflict?.path);
    });
  }

  // Log initial pair setup details
  for (const pairId of pairIds) {
    const pair = pairsMap?.get?.(pairId);
    if (pair) {
      const prefix = pair.options?.filter?.includePrefixes?.[0] || '/';
      console.log(`[sync-data] pair: ${pairId} prefix=${prefix} dir=${pair.options?.direction} root=${pair.root}`);
    }
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
