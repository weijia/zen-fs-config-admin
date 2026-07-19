import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { createConfigRepo, type IConfigRepo, type ConfigRepoOptions } from 'zen-fs-config';

interface ConfigRepoContextValue {
  repo: IConfigRepo | null;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  connect: (appId: string, options: ConfigRepoOptions) => Promise<void>;
  disconnect: () => Promise<void>;
}

const Context = createContext<ConfigRepoContextValue>({
  repo: null,
  connected: false,
  connecting: false,
  error: null,
  connect: async () => {},
  disconnect: async () => {},
});

export function ConfigRepoProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<IConfigRepo | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (appId: string, options: ConfigRepoOptions) => {
    setConnecting(true);
    setError(null);
    try {
      const r = await createConfigRepo(appId, options);
      setRepo(r);
      setConnected(true);
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
  }, [repo]);

  return (
    <Context.Provider value={{ repo, connected, connecting, error, connect, disconnect }}>
      {children}
    </Context.Provider>
  );
}

export function useConfigRepo() {
  return useContext(Context);
}