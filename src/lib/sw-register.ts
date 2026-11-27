/**
 * Service Worker 注册模块。
 *
 * 关键：`updateViaCache: 'none'`，让浏览器检查 SW 更新时绕过 HTTP 缓存，
 * 始终向服务器取最新 sw.js。否则 CDN / 代理缓存 sw.js 10 分钟，会一直检测不到更新。
 */
export function registerServiceWorker(swPath = './sw.js', scope?: string) {
  if (!('serviceWorker' in navigator)) return

  const doRegister = () => {
    const options: RegistrationOptions = { updateViaCache: 'none' }
    if (scope) options.scope = scope
    navigator.serviceWorker.register(swPath, options).catch((err) => {
      console.error('[PWA] Service Worker 注册失败:', err)
    })
  }

  // React 挂载可能晚于 load 事件，那时再 addEventListener 永远不会触发
  if (document.readyState === 'complete') doRegister()
  else window.addEventListener('load', doRegister, { once: true })
}
