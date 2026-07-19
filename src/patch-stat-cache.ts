/**
 * Monkey-patch CachedFileSystem.stat to correctly preserve isDirectory()
 * through JSON serialization round-trips.
 *
 * Upstream bug: zen-fs-cache <=1.0.1 uses JSON.stringify to cache stat
 * results, silently dropping isFile/isDirectory function properties.
 *
 * This patch intercepts the cache write path to embed __isDir as a boolean,
 * and the cache read path to restore the functions from __isDir.
 *
 * Remove once zen-fs-cache >= 1.0.2 is released with the fix.
 */

let patched = false;

export function patchStatCache() {
  if (patched) return;
  patched = true;

  import('zen-fs-cache').then(({ CachedFileSystem }) => {
    if (!CachedFileSystem) return;

    const origStat = CachedFileSystem.prototype.stat;
    CachedFileSystem.prototype.stat = async function (this: any, path: string) {
      const key = `stat:${path}`;
      const cached = await this.store.get(key);

      const tryCache = () => {
        if (!cached) return null;
        // Deserialize with __isDir restoration
        const raw = JSON.parse(new TextDecoder().decode(cached.value));
        const isDir = typeof raw.__isDir === 'boolean'
          ? raw.__isDir
          : typeof raw.isDirectory === 'boolean'
            ? raw.isDirectory
            : false;
        return { ...raw, isFile: () => !isDir, isDirectory: () => isDir };
      };

      const ttlOk = cached && this.ttlMs > 0 && Date.now() - cached.cachedAt < this.ttlMs;
      if (ttlOk) return tryCache();

      if (typeof this.inner.getRevision === 'function') {
        try {
          const rev2 = await this.inner.getRevision(path);
          if (cached && rev2 != null && rev2 === cached.revision) return tryCache();
        } catch { /* ignore */ }
      }

      // Cache miss — call inner stat and re-cache with __isDir
      const st = await this.inner.stat(path);
      const isDir = typeof st.isDirectory === 'function' ? st.isDirectory() : !!st.isDirectory;
      const serializable = { ...st, __isDir: isDir };

      let rev;
      if (typeof this.inner.getRevision === 'function') {
        try { rev = await this.inner.getRevision(path); } catch { /* ignore */ }
      }

      const enc = new TextEncoder().encode(JSON.stringify(serializable));
      await this.store.set(key, {
        value: enc,
        revision: rev,
        cachedAt: Date.now(),
      });

      return st;
    };

    console.log('[patch] CachedFileSystem.stat patched for isDirectory serialization');
  });
}

patchStatCache();
