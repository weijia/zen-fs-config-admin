import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { createConfigRepo, type IConfigRepo, type ConfigRepoOptions } from 'zen-fs-config';
import { setDebug } from 'zen-fs-sync';
import { versionDisplay, buildTimeDisplay } from '../version';
// Register all backend types (IndexedDB, WebStorage, GitHub, Gitee, WebDAV, RemoteStorage, ...)
// This must be imported BEFORE createConfigRepo() is called.
import '../register-backends';

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
 * Sync once and stop watching.
 *
 * IMPORTANT: Must unwatch ALL pairs FIRST to avoid race condition where
 * the watch poll triggers pair.sync() while we also call pair.sync().
 * SyncPair throws "already syncing" if called while another sync is running.
 */
async function syncOnceAndStop(repo: IConfigRepo) {
  try {
    setDebug('sync,detector');

    // @ts-ignore
    const engine = repo.syncEngine;
    if (!engine) return;

    const pairsMap = (engine as any).pairs || (engine as any)._pairs;
    if (!pairsMap || pairsMap.size === 0) return;

    // CRITICAL: Stop all watchers BEFORE syncing to avoid race condition
    const allPairs = engine.listPairs();
    for (const pairId of allPairs) {
      try { engine.unwatch(pairId); } catch { /* may not be watching */ }
    }

    console.log(`[sync] syncing ${pairsMap.size} pair(s) ...`);

    // Now sync each pair sequentially
    for (const [pairId, pair] of pairsMap.entries()) {
      try {
        // Reset snapshots to force full comparison (first-sync path)
        pair.sourceSnapshots = new Map();
        if (pair.options?.direction === 'bi-directional') {
          pair.targetSnapshots = new Map();
        }

        const result = await pair.sync();
        console.log(`[sync] ${pairId}: +${result?.filesCreated}/~${result?.filesUpdated}/-${result?.filesDeleted} skip:${result?.filesSkipped} ${result?.durationMs || '?'}ms`);
      } catch (err: any) {
        console.error(`[sync] ${pairId} failed:`, err.message || err);
      }
    }

    console.log('[sync] done, watches stopped');
    setDebug(false);
  } catch (err) {
    console.error('[sync] syncOnceAndStop error:', err);
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
      const r = await createConfigRepo(appId, options);
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
      const r = await createConfigRepo(params.appId, params.options);
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
