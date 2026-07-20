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
 * If syncPairs=0 but non-primary backends exist in stored meta,
 * fill empty replicas and do one more createConfigRepo cycle.
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

    const needsRepair = syncMeta.rules.some(r => r.direction !== 'none' && (!r.replicas || r.replicas.length === 0));
    if (!needsRepair) return repo;

    const fixedRules = syncMeta.rules.map(rule =>
      rule.direction === 'none' ? rule : { ...rule, replicas: enabledReplicaIds }
    );
    await repo.updateSyncRules({ version: 1, rules: fixedRules });
    await repo.dispose();

    const r2 = await createConfigRepo(appId, options);
    return r2;
  } catch (err) {
    return repo;
  }
}

function attachSyncDataLogger(repo: IConfigRepo) {
  // @ts-ignore - syncEngine is internal but accessible
  const engine = repo.syncEngine;
  if (!engine) return;

  engine.on('sync:start', (e: any) => {
    console.log('[sync-data] sync:start', e.pairId, e.timestamp);
  });
  engine.on('sync:end', (e: any) => {
    console.log('[sync-data] sync:end', e.pairId, 'result:', e.result);
  });
  engine.on('sync:error', (e: any) => {
    console.error('[sync-data] sync:error', e.pairId, e.error);
  });
  engine.on('conflict', (e: any) => {
    console.warn('[sync-data] conflict', e.pairId, e.path);
  });
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
