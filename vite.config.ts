import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

// Resolve the actually-installed zen-fs-gitee version at build time and inject
// it as a global constant, so the running app can log which gitee build it uses.
// zen-fs-gitee is ESM-only and its "exports" map exposes only ".", so we can't
// `import`/`require.resolve` its package.json. Instead read the manifest file
// directly from node_modules (walking up in case of a hoisted monorepo).
function getGiteeVersion(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'node_modules', 'zen-fs-gitee', 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        if (pkg && pkg.version) return pkg.version
      } catch {
        /* ignore, keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
}

const ZEN_FS_GITEE_VERSION = getGiteeVersion()

/**
 * 部署后浏览器/代理仍缓存着旧的 `index.html`，而它引用的是已被替换掉的
 * `assets/index-XXXX.js`（hash 变了）。于是首屏白屏、连「新版本可用」提示都
 * 渲染不出来。这里在入口 HTML 里放一个兜底：一旦发现脚本/样式加载失败，
 * 用带时间戳的地址强制重取一次（最多两次，避免缓存源本身出错时死循环）。
 */
const STALE_ASSET_RELOAD_SCRIPT = `<script>
(function () {
  var K = '__zf_stale_asset_reload';
  var kn = 0;
  function bust() {
    try {
      kn = (parseInt(sessionStorage.getItem(K) || '0', 10) || 0) + 1;
      if (kn > 2) return;
      sessionStorage.setItem(K, String(kn));
      var u = location.href.replace(/([?&])__r=\\d+/, '');
      location.replace(u + (u.indexOf('?') < 0 ? '?' : '&') + '__r=' + Date.now());
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) bust();
  }, true);
})();
</script>`

const staleAssetReload = {
  name: 'stale-asset-auto-reload',
  transformIndexHtml(html: string) {
    // 必须在第一个 <script type="module"> 之前注册监听，否则资源 404 的错误
    // 事件可能已经触发、监听器还没装上。
    const idx = html.indexOf('<script type="module"')
    if (idx < 0) return html
    return html.slice(0, idx) + `${STALE_ASSET_RELOAD_SCRIPT}\n  ` + html.slice(idx)
  },
}


// https://vite.dev/config/
export default defineConfig({
  define: {
    __ZEN_FS_GITEE_VERSION__: JSON.stringify(ZEN_FS_GITEE_VERSION),
  },
  plugins: [
    react(),
    staleAssetReload,
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
      manifest: {
        name: 'zen-fs-config-admin',
        short_name: 'zen-fs-config',
        description: 'Web admin dashboard for zen-fs-config',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
    }),
  ],
})