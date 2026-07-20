import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { createConfigRepo, type IConfigRepo, type ConfigRepoOptions } from 'zen-fs-config';

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

  console.log('[sync] syncPairs=0, checking stored backends for repair...');
  try {
    const backendsMeta = await repo.getBackends();
    const syncMeta = await repo.getSyncRules();
    if (!backendsMeta || !syncMeta) {
      console.log('[sync] no meta files, skipping repair');
      return repo;
    }

    const replicaIds = backendsMeta.backends.map(b => b.id).filter(id => id !== options.primaryBackendId);
    if (replicaIds.length === 0) {
      console.log('[sync] only primary backend exists, no repair needed');
      return repo;
    }

    const needsRepair = syncMeta.rules.some(r => r.direction !== 'none' && (!r.replicas || r.replicas.length === 0));
    if (!needsRepair) {
      console.log('[sync] syncRules already have replicas, no repair needed');
      return repo;
    }

    console.log('[sync] repair: filling empty replicas with:', replicaIds);
    const fixedRules = syncMeta.rules.map(rule =>
      rule.direction === 'none' ? rule : { ...rule, replicas: replicaIds }
    );
    await repo.updateSyncRules({ version: 1, rules: fixedRules });
    await repo.dispose();

    const r2 = await createConfigRepo(appId, options);
    console.log('[sync] repair done, syncPairs:', r2.getSyncStatuses().size);
    return r2;
  } catch (err) {
    console.error('[sync] repair failed:', err);
    return repo;
  }
}

export function ConfigRepoProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<IConfigRepo | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectParamsRef = useRef<{ appId: string; options: ConfigRepoOptions } | null>(null);

  const doConnect = useCallback(async (appId: string, options: ConfigRepoOptions) => {
    setConnecting(true);
    setError(null);
    try {
      console.log('[sync] createConfigRepo start, appId:', appId, 'primaryBackendId:', options.primaryBackendId);
      let r = await createConfigRepo(appId, options);
      r = await ensureSyncPairs(r, appId, options);
      connectParamsRef.current = { appId, options };
      saveConnectParams(appId, options);
      setRepo(r);
      setConnected(true);
      const syncStatuses = r.getSyncStatuses();
      console.log('[sync] connect done, syncPairs:', syncStatuses.size);
      syncStatuses.forEach((v, k) => console.log('[sync]   pair:', k, '→ status:', v));
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
    connectParamsRef.current = null;
    clearConnectParams();
  }, [repo]);

  const reconnect = useCallback(async () => {
    const params = connectParamsRef.current;
    if (!params) return;
    setReconnecting(true);
    try {
      console.log('[sync] reconnect start');
      if (repo) await repo.dispose();
      let r = await createConfigRepo(params.appId, params.options);
      r = await ensureSyncPairs(r, params.appId, params.options);
      setRepo(r);
      const syncStatuses = r.getSyncStatuses();
      console.log('[sync] reconnect done, syncPairs:', syncStatuses.size);
      syncStatuses.forEach((v, k) => console.log('[sync]   pair:', k, '→ status:', v));
    } catch (err: any) {
      console.error('[sync] reconnect failed:', err);
      setError(err.message || String(err));
    } finally {
      setReconnecting(false);
    }
  }, [repo]);

  // Auto-reconnect on page refresh
  useEffect(() => {
    const saved = loadConnectParams();
    if (!saved) return;
    console.log('[sync] auto-reconnecting from saved params, appId:', saved.appId);
    setConnecting(true);
    createConfigRepo(saved.appId, saved.options)
      .then(async r => {
        r = await ensureSyncPairs(r, saved.appId, saved.options);
        connectParamsRef.current = saved;
        setRepo(r);
        setConnected(true);
        console.log('[sync] auto-reconnect done, syncPairs:', r.getSyncStatuses().size);
      })
      .catch(err => {
        console.error('[sync] auto-reconnect failed:', err);
        clearConnectParams();
      })
      .finally(() => setConnecting(false));
  }, []);

  return (
    <Context.Provider value={{ repo, connected, connecting, reconnecting, error, connect, disconnect, reconnect }}>
      {children}
    </Context.Provider>
  );
}

export function useConfigRepo() {
  return useContext(Context);
}
