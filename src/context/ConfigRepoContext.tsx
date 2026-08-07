import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { createConfigRepo, type IConfigRepo } from 'zen-fs-config';
import { versionDisplay, buildTimeDisplay } from '../version';
// Register all backend types (IndexedDB, WebStorage, GitHub, Gitee, WebDAV, RemoteStorage, ...)
// This must be imported BEFORE createConfigRepo() is called.
import '../register-backends';

const NODE_ID_STORAGE_KEY = 'zen-fs-config-admin:node-id';
const APP_ID = 'admin';
const CACHE_TTL_MS = 300000; // 5 min — shouldSync is the primary gate; TTL is a secondary safety net

function getOrCreateNodeId(): string {
  try {
    let nodeId = localStorage.getItem(NODE_ID_STORAGE_KEY);
    if (!nodeId) {
      nodeId = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(NODE_ID_STORAGE_KEY, nodeId);
    }
    return nodeId;
  } catch {
    return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

interface ConfigRepoContextValue {
  repo: IConfigRepo | null;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  error: string | null;
  primaryBackendId: string | null;
  reconnect: () => Promise<void>;
}

const Context = createContext<ConfigRepoContextValue>({
  repo: null,
  connected: false,
  connecting: false,
  reconnecting: false,
  error: null,
  primaryBackendId: null,
  reconnect: async () => {},
});

async function createRepo(): Promise<IConfigRepo> {
  const nodeId = getOrCreateNodeId();
  return createConfigRepo(APP_ID, {
    nodeId,
    cache: { storeType: 'IdbCacheStore', ttlMs: CACHE_TTL_MS },
  });
}

export function ConfigRepoProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<IConfigRepo | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [primaryBackendId] = useState<string | null>('local-idb');
  /** Ref to the current repo so reconnect can safely dispose it even after a React re-render. */
  const repoRef = useRef<IConfigRepo | null>(null);

  // Auto-connect on mount.
  // createConfigRepo() loads local IndexedDB data synchronously and starts
  // background sync — we don't wait for remote sync to finish.
  useEffect(() => {
    let cancelled = false;
    setConnecting(true);
    setError(null);
    createRepo()
      .then(r => {
        if (cancelled) { try { r.dispose(); } catch { /* ignore */ } return; }
        repoRef.current = r;
        setRepo(r);
        setConnected(true);
        console.log('[version] connected:', versionDisplay, '| build:', buildTimeDisplay);
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[version] auto-connect failed:', err);
          setError(err.message || String(err));
        }
      })
      .finally(() => { if (!cancelled) setConnecting(false); });
    return () => { cancelled = true; };
  }, []);

  const reconnect = useCallback(async () => {
    setReconnecting(true);
    setError(null);
    try {
      const newRepo = await createRepo();

      // Swap refs atomically
      const oldRepo = repoRef.current;
      repoRef.current = newRepo;
      setRepo(newRepo);

      // Dispose old repo AFTER swap
      try { if (oldRepo) await oldRepo.dispose(); } catch { /* already disposed */ }

      console.log('[version] reconnected:', versionDisplay, '| build:', buildTimeDisplay);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setReconnecting(false);
    }
  }, []);

  return (
    <Context.Provider value={{ repo, connected, connecting, reconnecting, error, primaryBackendId, reconnect }}>
      {children}
    </Context.Provider>
  );
}

export function useConfigRepo() {
  return useContext(Context);
}
