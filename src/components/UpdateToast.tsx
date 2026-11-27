import { useEffect, useRef, useState } from 'react'
import { createLogger } from '@richard432/localstorage-logger'
import { applyUpdate, checkForUpdate, type UpdateCheckResult } from '../lib/update-check'
import { setUpdateAvailable, versionKey } from '../lib/update-store'

const log = createLogger('admin:update-toast')

const CHECK_INTERVAL = 5 * 60 * 1000

/**
 * 自动更新提醒：
 *  - 页面加载 3 秒后检查一次，之后每 5 分钟检查一次，回到前台时也检查；
 *  - 走双通道（远端 version.json + SW 的 waiting Worker），SW 坏掉也能发现新版本；
 *  - 同一个版本点过「稍后」后不再弹提示，但顶部「检查更新」按钮的小圆点会保留。
 */
export default function UpdateToast() {
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const dismissedKey = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let lastKey: string | null = null

    const announce = (r: UpdateCheckResult) => {
      if (cancelled || r.status !== 'update-available') return
      setUpdateAvailable(r)
      const key = versionKey(r)
      if (key === lastKey) return
      lastKey = key
      log.log('[PWA] 发现新版本', r.message)
      if (dismissedKey.current === key) return
      setError('')
      setApplying(false)
      setResult(r)
    }

    const run = async () => {
      try {
        announce(await checkForUpdate())
      } catch (err) {
        log.error('[PWA] 自动检查更新失败', err)
      }
    }

    const initial = setTimeout(run, 3000)
    const interval = setInterval(run, CHECK_INTERVAL)

    // 已有等待中的 Worker（例如上次没点更新就关了页面）→ 立刻提示
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready
        .then((reg) => {
          if (reg.waiting) void run()
        })
        .catch(() => {
          /* 无 SW 时交给 version.json 通道 */
        })
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void run()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearTimeout(initial)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const dismiss = () => {
    if (result) dismissedKey.current = versionKey(result)
    setResult(null)
  }

  const doApply = async () => {
    setApplying(true)
    setError('')
    try {
      await applyUpdate()
      // applyUpdate 内部会重载；没重载成功时给出明确提示，避免用户以为卡住
      setError('更新已下发但页面未自动刷新，请手动刷新页面')
    } catch (err) {
      setApplying(false)
      setError(`应用更新失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!result) return null

  const remoteLabel = result.remote
    ? `${result.remote.version || result.remote.sha || '新版本'}${result.remote.buildTime ? `（${result.remote.buildTime}）` : ''}`
    : '后台已下载新版本'

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 40,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 300,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          padding: '10px 14px',
          borderRadius: 8,
          border: '1px solid var(--border)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          fontSize: 13,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ marginBottom: 2 }}>
            {applying ? '正在应用更新…' : `发现新版本 ${remoteLabel}`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            本机 {result.local.sha || '?'} · {result.local.buildTime || '未知时间'}
            {result.remote?.sha ? ` → 远端 ${result.remote.sha}` : ''}
          </div>
          {error && (
            <div style={{ fontSize: 11, color: 'var(--warning, #d29922)', marginTop: 3 }}>{error}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            className="btn btn-sm btn-secondary"
            onClick={dismiss}
            disabled={applying}
          >
            稍后
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void doApply()}
            disabled={applying}
          >
            {applying ? '更新中…' : '立即更新'}
          </button>
        </div>
      </div>
    </div>
  )
}
