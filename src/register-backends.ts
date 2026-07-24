/**
 * Register all backend types that zen-fs-config-admin supports.
 *
 * zen-fs-config only ships with InMemory built in.  All other backends
 * are registered here at app startup, using whatever packages the admin
 * app decides to bundle.
 *
 * Adding a new backend?  Just add another registerBackend() call here
 * and update backend-types.ts — no changes needed to zen-fs-config.
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
});

// ---------------------------------------------------------------------------
// Gitee
//
// Gitee's /git/trees/{sha} requires a SHA, not a branch name (unlike GitHub).
// We patch GiteeFS.prototype.init so that after indexing it resolves the
// branch name to a tree SHA on the first 404.
// ---------------------------------------------------------------------------

registerBackend('Gitee', async (options) => {
  const zenGitee = await import('zen-fs-gitee');

  const { GiteeFS } = zenGitee as any;
  const origInit = GiteeFS.prototype.init;

  // Use a WeakSet to avoid double-patching
  const patched = new WeakSet();
  GiteeFS.prototype.init = async function (this: any) {
    let firstErr: any;
    try {
      return await origInit.call(this);
    } catch (err: any) {
      if (!err.message?.includes('404') && !err.message?.includes('Tree not found')) {
        throw err;
      }
      firstErr = err;
    }
    // getTree inside init() failed — resolve branch → SHA and retry
    if (patched.has(this)) throw firstErr;
    patched.add(this);

    console.log(`[Gitee] init failed with branch="${this.api.branch}", resolving to SHA...`);
    const baseUrl = this.api.baseUrl || 'https://gitee.com/api/v5';
    const auth = `access_token=${this.api.token}`;

    // GET /repos/{owner}/{repo}/branches/{branch} → commit.sha
    const branchUrl = `${baseUrl}/repos/${this.api.owner}/${this.api.repo}/branches/${this.api.branch}?${auth}`;
    let branchRes = await fetch(branchUrl);
    let branchData: any;

    if (branchRes.ok) {
      branchData = await branchRes.json();
    } else {
      // Branch doesn't exist — create it from the default branch (master/main)
      console.log(`[Gitee] Branch "${this.api.branch}" not found, creating...`);
      const defaultBranch = this.api.branch === 'master' ? 'main' : 'master';

      // Find the default branch's SHA
      let defaultSha: string | undefined;
      for (const name of [defaultBranch, 'main', 'master']) {
        const dr = await fetch(`${baseUrl}/repos/${this.api.owner}/${this.api.repo}/branches/${name}?${auth}`);
        if (dr.ok) {
          const dd: any = await dr.json();
          defaultSha = dd.commit?.sha;
          if (defaultSha) break;
        }
      }

      if (!defaultSha) {
        // No branches at all — repo is empty. We must create an initial file
        // via the Contents API to implicitly create the branch.
        // Gitee has no POST /git/refs endpoint, so we cannot create a branch
        // from thin air; we need at least one commit.
        console.log(`[Gitee] No branches found in repo, creating initial file to bootstrap branch "${this.api.branch}"...`);
        const initRes = await fetch(
          `${baseUrl}/repos/${this.api.owner}/${this.api.repo}/contents/.gitkeep?branch=${this.api.branch}&${auth}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: btoa(''),
              message: `Initialize branch '${this.api.branch}'`,
            }),
          }
        );
        if (!initRes.ok) {
          const errText = await initRes.text().catch(() => '');
          throw new Error(`Gitee: failed to bootstrap empty repo: ${initRes.status} ${errText}`);
        }
        // After creating the initial file, the branch exists. Retry tree init.
        this.initialized = false;
        return origInit.call(this);
      }

      // POST /repos/{owner}/{repo}/branches to create branch
      const createRes = await fetch(`${baseUrl}/repos/${this.api.owner}/${this.api.repo}/branches?${auth}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refs: defaultSha,
          branch_name: this.api.branch,
        }),
      });

      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => '');
        throw new Error(`Gitee: failed to create branch "${this.api.branch}": ${createRes.status} ${errText}`);
      }

      branchData = await createRes.json();
      console.log(`[Gitee] Branch "${this.api.branch}" created from ${defaultSha.slice(0, 8)}`);
    }

    const commitSha = branchData.commit?.sha;
    if (!commitSha) throw new Error(`Gitee: could not get commit SHA for branch "${this.api.branch}"`);

    // GET /repos/{owner}/{repo}/git/commits/{sha} → tree.sha
    const commitUrl = `${baseUrl}/repos/${this.api.owner}/${this.api.repo}/git/commits/${commitSha}?${auth}`;
    const commitRes = await fetch(commitUrl);
    if (!commitRes.ok) throw new Error(`Gitee: commit ${commitSha} not found (${commitRes.status})`);
    const commitData: any = await commitRes.json();
    const treeSha = commitData.tree?.sha;
    if (!treeSha) throw new Error(`Gitee: could not get tree SHA from commit ${commitSha}`);

    // Replace branch with tree SHA so getTree() succeeds
    const realBranch = this.api.branch;
    this.api.branch = treeSha;
    console.log(`[Gitee] Resolved branch="${realBranch}" → commit=${commitSha.slice(0, 8)} → tree=${treeSha.slice(0, 8)}`);

    try {
      return await origInit.call(this);
    } finally {
      // Restore original branch name for other API calls (getContents, getRaw, etc.)
      this.api.branch = realBranch;
    }
  };

  return wrapZenFSFileSystem({
    backend: zenGitee.Gitee,
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    branch: options.branch,
    baseUrl: (options.baseUrl && (options.baseUrl as string).trim()) || undefined,
  });
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
});
