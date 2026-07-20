import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import { createConfigRepo, type IConfigRepo, type ConfigRepoOptions } from 'zen-fs-config';

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

export function ConfigRepoProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<IConfigRepo | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectParamsRef = useRef<{ appId: string; options: ConfigRepoOptions } | null>(null);

  const connect = useCallback(async (appId: string, options: ConfigRepoOptions) => {
    setConnecting(true);
    setError(null);
    try {
      console.log('[sync] createConfigRepo start, appId:', appId, 'primaryBackendId:', options.primaryBackendId);
      const r = await createConfigRepo(appId, options);
      connectParamsRef.current = { appId, options };
      setRepo(r);
      setConnected(true);
      const syncStatuses = r.getSyncStatuses();
      console.log('[sync] createConfigRepo done, syncPairs:', syncStatuses.size);
      syncStatuses.forEach((v, k) => console.log('[sync]   pair:', k, '→ status:', v));
    } catch (err: any) {
      setError(err.message || String(err));
      throw err;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (repo) {
      await repo.dispose();
    }
    setRepo(null);
    setConnected(false);
    setError(null);
    connectParamsRef.current = null;
  }, [repo]);

  const reconnect = useCallback(async () => {
    const params = connectParamsRef.current;
    if (!params) return;
    setReconnecting(true);
    try {
      console.log('[sync] reconnect start (dispose old repo, create new with same params)');
      if (repo) await repo.dispose();
      const r = await createConfigRepo(params.appId, params.options);
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

  return (
    <Context.Provider value={{ repo, connected, connecting, reconnecting, error, connect, disconnect, reconnect }}>
      {children}
    </Context.Provider>
  );
}

export function useConfigRepo() {
  return useContext(Context);
}
