import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { createConfigRepo, type IConfigRepo } from 'zen-fs-config';
import { versionDisplay, buildTimeDisplay } from '../version';
// Register all backend types (IndexedDB, WebStorage, GitHub, Gitee, WebDAV, RemoteStorage, ...)
// This must be imported BEFORE createConfigRepo() is called.
import '../register-backends';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:config-repo-context');

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

// ---------------------------------------------------------------------------
// 数据同步组（app data group）
//
// 激活 / 释放逻辑抽到 ../data-group-activation，供多实例注册表复用。
// 这里 re-export `activateDataGroups` 保持既有的 import 路径可用。
// ---------------------------------------------------------------------------

import { activateDataGroups, disposeDataGroups, type DataGroupInfo } from '../data-group-activation';
export { activateDataGroups };
export type { DataGroupInfo };

interface ConfigRepoContextValue {
  repo: IConfigRepo | null;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  error: string | null;
  primaryBackendId: string | null;
  reconnect: () => Promise<void>;
  /** 已激活的数据同步组（appId='admin'）。 */
  dataGroups: DataGroupInfo[];
  /** 是否正在枚举 / 激活数据组。 */
  dataGroupsLoading: boolean;
  /** 激活过程中失败的数据组 id → 错误信息。 */
  dataGroupsError: string | null;
  /** 取某组的 fs（chroot 到组根），供文件浏览器使用。 */
  getDataGroupFs: (id: string) => any | null;
  /** CRUD 操作后刷新数据组列表。 */
  refreshDataGroups: () => Promise<void>;
}

const Context = createContext<ConfigRepoContextValue>({
  repo: null,
  connected: false,
  connecting: false,
  reconnecting: false,
  error: null,
  primaryBackendId: null,
  reconnect: async () => {},
  dataGroups: [],
  dataGroupsLoading: false,
  dataGroupsError: null,
  getDataGroupFs: () => null,
  refreshDataGroups: async () => {},
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

  const [dataGroups, setDataGroups] = useState<DataGroupInfo[]>([]);
  const [dataGroupsLoading, setDataGroupsLoading] = useState(false);
  const [dataGroupsError, setDataGroupsError] = useState<string | null>(null);

  /** Ref to the current repo so reconnect can safely dispose it even after a React re-render. */
  const repoRef = useRef<IConfigRepo | null>(null);
  /** 已激活的数据组句柄引用，便于卸载 / 重连时释放。 */
  const dataGroupsRef = useRef<DataGroupInfo[]>([]);

  /**
   * 枚举 + 激活当前 repo 的数据组，并更新状态。
   * 返回激活结果，便于调用方链式处理。
   */
  const loadDataGroups = useCallback(async (target: IConfigRepo | null): Promise<DataGroupInfo[]> => {
    if (!target) {
      dataGroupsRef.current = [];
      setDataGroups([]);
      setDataGroupsError(null);
      return [];
    }
    setDataGroupsLoading(true);
    try {
      const infos = await activateDataGroups(target);
      dataGroupsRef.current = infos;
      setDataGroups(infos);
      const failed = infos.filter(i => i.error);
      setDataGroupsError(
        failed.length > 0
          ? `${failed.length} data group(s) failed to activate: ${failed.map(f => f.id).join(', ')}`
          : null,
      );
      return infos;
    } catch (err: any) {
      log.error('[data-groups] activation failed:', err?.message ?? err);
      setDataGroupsError(err?.message ?? String(err));
      return [];
    } finally {
      setDataGroupsLoading(false);
    }
  }, []);

  const getDataGroupFs = useCallback((id: string): any | null => {
    const info = dataGroupsRef.current.find(i => i.id === id);
    const fs = info?.group?.fs as any;
    if (!fs) return null;
    return fs.promises ?? fs;
  }, []);

  const refreshDataGroups = useCallback(async () => {
    await loadDataGroups(repoRef.current);
  }, [loadDataGroups]);

  // Auto-connect on mount.
  // createConfigRepo() loads local IndexedDB data synchronously and starts
  // background sync — we don't wait for remote sync to finish.
  useEffect(() => {
    let cancelled = false;
    setConnecting(true);
    setError(null);
    createRepo()
      .then(async r => {
        if (cancelled) { try { r.dispose(); } catch { /* ignore */ } return; }
        repoRef.current = r;
        setRepo(r);
        setConnected(true);
        log.log('[version] connected:', versionDisplay, '| build:', buildTimeDisplay);
        // 配置仓就绪后自动激活数据同步组（不阻塞首屏）
        if (!cancelled) await loadDataGroups(r);
      })
      .catch(err => {
        if (!cancelled) {
          log.error('[version] auto-connect failed:', err);
          setError(err.message || String(err));
        }
      })
      .finally(() => { if (!cancelled) setConnecting(false); });
    return () => {
      cancelled = true;
      // 释放数据组与 repo，避免重复 SyncPair / 资源泄漏
      void disposeDataGroups(dataGroupsRef.current);
      dataGroupsRef.current = [];
      try { repoRef.current?.dispose(); } catch { /* already disposed */ }
      repoRef.current = null;
    };
  }, [loadDataGroups]);

  const reconnect = useCallback(async () => {
    setReconnecting(true);
    setError(null);
    try {
      const newRepo = await createRepo();

      // Swap refs atomically
      const oldRepo = repoRef.current;
      const oldGroups = dataGroupsRef.current;
      repoRef.current = newRepo;
      dataGroupsRef.current = [];
      setRepo(newRepo);

      // Dispose old repo AFTER swap（repo.dispose() 内部也会释放其数据组）
      try { await disposeDataGroups(oldGroups); } catch { /* already disposed */ }
      try { if (oldRepo) await oldRepo.dispose(); } catch { /* already disposed */ }

      // 在新 repo 上重新激活数据组
      await loadDataGroups(newRepo);

      log.log('[version] reconnected:', versionDisplay, '| build:', buildTimeDisplay);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setReconnecting(false);
    }
  }, [loadDataGroups]);

  return (
    <Context.Provider value={{
      repo,
      connected,
      connecting,
      reconnecting,
      error,
      primaryBackendId,
      reconnect,
      dataGroups,
      dataGroupsLoading,
      dataGroupsError,
      getDataGroupFs,
      refreshDataGroups,
    }}>
      {children}
    </Context.Provider>
  );
}

export function useConfigRepo() {
  return useContext(Context);
}
