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

// https://vite.dev/config/
export default defineConfig({
  define: {
    __ZEN_FS_GITEE_VERSION__: JSON.stringify(ZEN_FS_GITEE_VERSION),
  },
  plugins: [
    react(),
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