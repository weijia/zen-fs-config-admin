/**
 * Register all backend types that zen-fs-config-admin supports.
 *
 * zen-fs-config only ships with InMemory built in.  All other backends
 * are registered here at app startup, using whatever packages the admin
 * app decides to bundle.
 *
 * Adding a new backend?  Just add another registerBackend() call here
 * and pass the metadata as the 3rd argument — no changes needed to zen-fs-config.
 */

import { registerBackend, wrapZenFSFileSystem } from 'zen-fs-config';

// ---------------------------------------------------------------------------
// IndexedDB (browser local)
// ---------------------------------------------------------------------------

let idbCounter = 0;

registerBackend('IndexedDB', async (options) => {
  const { IndexedDB } = await import('@zenfs/dom');

  const storeName = (options.storeName as string) ?? `zen-fs-config-${++idbCounter}`;

  return wrapZenFSFileSystem({ backend: IndexedDB, storeName });
}, {
  type: 'IndexedDB',
  label: 'IndexedDB',
  icon: '\u{1F4BE}',
  fields: [
    { key: 'storeName', label: 'Store Name', type: 'text', placeholder: 'zen-fs-config-1' },
  ],
  defaultOptions: { storeName: '' },
});

// ---------------------------------------------------------------------------
// WebStorage / localStorage (browser local)
// ---------------------------------------------------------------------------

registerBackend('WebStorage', async (options) => {
  const { WebStorage } = await import('@zenfs/dom');

  const storageType = (options.storageType as string) ?? 'localStorage';

  let storage: Storage;
  if (storageType === 'sessionStorage' && typeof sessionStorage !== 'undefined') {
    storage = sessionStorage;
  } else {
    storage = localStorage;
  }

  return wrapZenFSFileSystem({ backend: WebStorage, storage });
}, {
  type: 'WebStorage',
  label: 'WebStorage',
  icon: '\u{1F4BE}',
  fields: [
    { key: 'storageType', label: 'Storage Type', type: 'select', options: [
      { value: 'localStorage', label: 'localStorage' },
      { value: 'sessionStorage', label: 'sessionStorage' },
    ]},
  ],
  defaultOptions: { storageType: 'localStorage' },
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

registerBackend('GitHub', async (options) => {
  const { Github } = await import('zen-fs-github');
  return wrapZenFSFileSystem({
    backend: Github,
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    branch: options.branch,
    baseUrl: (options.baseUrl && (options.baseUrl as string).trim()) || undefined,
  });
}, {
  type: 'GitHub',
  label: 'GitHub',
  icon: '\u{1F419}',
  fields: [
    { key: 'owner', label: 'Owner', type: 'text', placeholder: 'weijia', required: true },
    { key: 'repo', label: 'Repo', type: 'text', placeholder: 'my-configs', required: true },
    { key: 'branch', label: 'Branch', type: 'text', placeholder: 'main' },
    { key: 'token', label: 'Token', type: 'password', placeholder: 'ghp_xxxx' },
    { key: 'baseUrl', label: 'API URL', type: 'text', placeholder: 'https://api.github.com' },
  ],
  defaultOptions: { owner: '', repo: '', branch: 'main', token: '', baseUrl: '' },
});

// ---------------------------------------------------------------------------
// Gitee
// ---------------------------------------------------------------------------

registerBackend('Gitee', async (options) => {
  const { Gitee } = await import('zen-fs-gitee');
  return wrapZenFSFileSystem({
    backend: Gitee,
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    branch: options.branch,
    baseUrl: (options.baseUrl && (options.baseUrl as string).trim()) || undefined,
  });
}, {
  type: 'Gitee',
  label: 'Gitee',
  icon: '\u{1F98A}',
  fields: [
    { key: 'owner', label: 'Owner', type: 'text', placeholder: 'weijia', required: true },
    { key: 'repo', label: 'Repo', type: 'text', placeholder: 'my-configs', required: true },
    { key: 'branch', label: 'Branch', type: 'text', placeholder: 'master' },
    { key: 'token', label: 'Token', type: 'password', placeholder: 'gitee token' },
    { key: 'baseUrl', label: 'API URL', type: 'text', placeholder: 'https://gitee.com/api/v5' },
  ],
  defaultOptions: { owner: '', repo: '', branch: 'master', token: '', baseUrl: '' },
});

// ---------------------------------------------------------------------------
// WebDAV
// ---------------------------------------------------------------------------

registerBackend('WebDAV', async (options) => {
  const url = (options.url as string) ?? '';
  const username = (options.username as string) ?? '';
  const password = (options.password as string) ?? '';
  const rootPath = (options.rootPath as string) ?? '/';

  if (!url) throw new Error('WebDAV backend requires "url" option');

  const authHeader = username ? `Basic ${btoa(`${username}:${password}`)}` : '';

  const davUrl = (path: string) => {
    const cleanRoot = rootPath.replace(/\/$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${url.replace(/\/$/, '')}${cleanRoot}${cleanPath}`;
  };

  const davFetch = async (path: string, method: string, body?: any) => {
    const headers: Record<string, string> = {};
    if (authHeader) headers['Authorization'] = authHeader;
    if (body) headers['Content-Type'] = 'application/xml';
    const res = await fetch(davUrl(path), { method, headers, body });
    if (!res.ok && res.status !== 404) throw new Error(`WebDAV ${res.status} ${method} ${davUrl(path)}`);
    return res;
  };

  const parseMultiStatus = async (res: Response): Promise<{ path: string; isDir: boolean; size: number }[]> => {
    const text = await res.text();
    const results: { path: string; isDir: boolean; size: number }[] = [];
    // Simple XML parsing for DAV:response elements
    const responses = text.match(/<D:response[^>]*>[\s\S]*?<\/D:response>/gi) || [];
    for (const resp of responses) {
      const href = (resp.match(/<D:href>([^<]+)<\/D:href>/i) || [])[1] || '';
      const isDir = /<D:collection\s*\/>/i.test(resp) || /<D:resourcetype>.*<D:collection/.test(resp);
      const sizeMatch = resp.match(/<D:getcontentlength>([^<]+)<\/D:getcontentlength>/i);
      const size = sizeMatch ? parseInt(sizeMatch[1]) : 0;
      const decoded = decodeURIComponent(href);
      results.push({ path: decoded, isDir, size });
    }
    return results;
  };

  const exists = async (path: string): Promise<boolean> => {
    const res = await davFetch(path, 'PROPFIND');
    return res.ok;
  };

  const backend = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      const res = await davFetch(path, 'GET');
      if (!res.ok) throw new Error(`ENOENT: ${path}`);
      if (args[0] === 'utf-8') return res.text();
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, _options?: any): Promise<void> {
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
      if (authHeader) headers['Authorization'] = authHeader;
      await fetch(davUrl(path), {
        method: 'PUT',
        headers,
        body: data instanceof ArrayBuffer ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer as ArrayBuffer : new TextEncoder().encode(data),
      });
    },
    async readdir(path: string): Promise<string[]> {
      const headers: Record<string, string> = { Depth: '1' };
      if (authHeader) headers['Authorization'] = authHeader;
      const res = await fetch(davUrl(path), { method: 'PROPFIND', headers });
      if (!res.ok) throw new Error(`WebDAV PROPFIND failed: ${res.status}`);
      const items = await parseMultiStatus(res);
      const prefix = davUrl(path);
      return items
        .filter(i => i.path !== prefix && i.path !== `${prefix}/`)
        .map(i => i.path.split('/').filter(Boolean).pop() || '');
    },
    async stat(path: string): Promise<any> {
      const headers: Record<string, string> = { Depth: '0' };
      if (authHeader) headers['Authorization'] = authHeader;
      const res = await fetch(davUrl(path), { method: 'PROPFIND', headers });
      if (!res.ok) throw new Error(`ENOENT: ${path}`);
      const items = await parseMultiStatus(res);
      const item = items[0];
      return {
        mode: item.isDir ? 0o040755 : 0o100644,
        size: item.size,
        mtimeMs: 0,
      };
    },
    async exists(path: string): Promise<boolean> {
      return exists(path);
    },
    async mkdir(path: string): Promise<any> {
      const headers: Record<string, string> = {};
      if (authHeader) headers['Authorization'] = authHeader;
      const res = await fetch(davUrl(path), { method: 'MKCOL', headers });
      if (!res.ok && res.status !== 405) throw new Error(`WebDAV MKCOL failed: ${res.status}`);
    },
    async unlink(path: string): Promise<void> {
      await davFetch(path, 'DELETE');
    },
    async rmdir(path: string): Promise<void> {
      const items = await (async () => {
        const headers: Record<string, string> = { Depth: '1' };
        if (authHeader) headers['Authorization'] = authHeader;
        const res = await fetch(davUrl(path), { method: 'PROPFIND', headers });
        if (!res.ok) return [];
        const parsed = await parseMultiStatus(res);
        const prefix = davUrl(path);
        return parsed.filter(i => i.path !== prefix && i.path !== `${prefix}/`);
      })();
      for (const item of items) {
        if (item.isDir) await backend.rmdir(item.path);
        else await backend.unlink(item.path);
      }
      await davFetch(path, 'DELETE');
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      const headers: Record<string, string> = { Destination: davUrl(newPath) };
      if (authHeader) headers['Authorization'] = authHeader;
      await fetch(davUrl(oldPath), { method: 'MOVE', headers });
    },
  };

  return backend;
}, {
  type: 'WebDAV',
  label: 'WebDAV',
  icon: '\u{2601}\u{FE0F}',
  fields: [
    { key: 'url', label: 'URL', type: 'text', placeholder: 'https://dav.example.com/remote.php/dav/files/', required: true },
    { key: 'username', label: 'Username', type: 'text', placeholder: 'admin' },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'rootPath', label: 'Root Path', type: 'text', placeholder: '/zen-fs-config/' },
  ],
  defaultOptions: { url: '', username: '', password: '', rootPath: '/' },
});

// ---------------------------------------------------------------------------
// RemoteStorage (zen-fs-remotestoragejs)
// ---------------------------------------------------------------------------

registerBackend('RemoteStorage', async (options) => {
  const { RemoteStorageFileSystem } = await import('zen-fs-remotestoragejs');

  const href = (options.href as string) ?? '';
  const token = (options.token as string) ?? '';
  if (!href) throw new Error('RemoteStorage backend requires "href" option');
  if (!token) throw new Error('RemoteStorage backend requires "token" option');

  const basePath = (options.basePath as string) || undefined;

  const fs = new RemoteStorageFileSystem({ href, token, basePath });

  // RemoteStorageFileSystem provides a fs.promises-like API.
  // Bridge it to our BackendInstance interface.
  const fsAny = fs as any;
  return {
    async readFile(path: string, ...args: any[]): Promise<any> {
      return fsAny.readFile(path, ...args);
    },
    async writeFile(path: string, data: any, opts?: any): Promise<void> {
      await fsAny.writeFile(path, data, opts);
    },
    async readdir(path: string): Promise<string[]> {
      return fsAny.readdir(path);
    },
    async stat(path: string, ..._args: any[]): Promise<any> {
      return fsAny.stat(path);
    },
    async exists(path: string): Promise<boolean> {
      return fsAny.exists(path);
    },
    async mkdir(path: string, options?: any): Promise<any> {
      return fsAny.mkdir(path, options);
    },
    async unlink(path: string): Promise<void> {
      await fsAny.unlink(path);
    },
    async rmdir(path: string): Promise<void> {
      await fsAny.rmdir(path);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      await fsAny.rename(oldPath, newPath);
    },
  };
}, {
  type: 'RemoteStorage',
  label: 'RemoteStorage',
  icon: '\u{1F4E1}',
  fields: [
    { key: 'href', label: 'User Address (href)', type: 'text', placeholder: 'user@5apps.com', required: true },
    { key: 'token', label: 'Bearer Token', type: 'password', placeholder: 'rs-xxxxxxxx', required: true },
    { key: 'basePath', label: 'Base Path', type: 'text', placeholder: '/zen-fs-config/' },
  ],
  defaultOptions: { href: '', token: '', basePath: '/' },
});
