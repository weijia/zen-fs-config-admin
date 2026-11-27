import { useEffect, useRef, useState } from 'react'
import { applyUpdate, checkForUpdate, forceUpdate, type UpdateCheckResult } from '../lib/update-check'
import { setUpdateAvailable, subscribeUpdate } from '../lib/update-store'

type Phase = 'idle' | 'checking' | 'available' | 'latest' | 'unknown' | 'applying'

function CloudDownloadIcon({ pulse }: { pulse?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ opacity: pulse ? 0.6 : 1 }}
      aria-hidden="true"
    >
      <path d="M12 13v8" />
      <path d="m8 17 4 4 4-4" />
      <path d="M4.5 15.5A4.5 4.5 0 0 1 6 6.7 6 6 0 0 1 17.5 9a4 4 0 0 1-.9 7.9" />
    </svg>
  )
}

/**
 * 顶部「检查更新 / 强制更新」按钮。
 *
 * 点击即主动比对远端 version.json，并探测 SW 是否已有 waiting Worker；
 * 发现新版本后点「立即更新」：有 waiting Worker 走 SKIP_WAITING，否则注销 SW + 清缓存后重载。
 * 「强制更新」不比对版本，直接清 SW 与全部 Cache Storage 再重载，用于页面内容可疑过期的兜底。
 */
export default function UpdateCheckButton() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [detail, setDetail] = useState('')
  const [autoAvailable, setAutoAvailable] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => subscribeUpdate((s) => setAutoAvailable(s.available)), [])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) {
        if (hideTimer.current) clearTimeout(hideTimer.current)
        setPhase((p) => (p === 'checking' || p === 'applying' ? p : 'idle'))
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  const scheduleHide = (ms: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      setPhase((p) => (p === 'checking' || p === 'applying' ? p : 'idle'))
    }, ms)
  }

  const runCheck = async () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setPhase('checking')
    setDetail('')
    try {
      const r = await checkForUpdate()
      setResult(r)
      if (r.status === 'update-available') {
        setUpdateAvailable(r)
        setPhase('available')
      } else if (r.status === 'up-to-date') {
        setPhase('latest')
        scheduleHide(4000)
      } else {
        setPhase('unknown')
        setDetail(r.message)
        scheduleHide(10000)
      }
    } catch (err) {
      setPhase('unknown')
      setDetail(err instanceof Error ? err.message : String(err))
      scheduleHide(10000)
    }
  }

  const doApply = async () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setPhase('applying')
    setDetail('正在应用更新…')
    try {
      await applyUpdate()
      setDetail('更新已下发，若页面未自动刷新请手动刷新')
    } catch (err) {
      setPhase('unknown')
      setDetail(`应用更新失败：${err instanceof Error ? err.message : String(err)}`)
      scheduleHide(10000)
    }
  }

  const doForce = async () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setPhase('applying')
    setDetail('正在强制更新：注销 Service Worker 并清空缓存…')
    try {
      await forceUpdate()
      setDetail('强制更新完成，若页面未自动刷新请手动刷新')
    } catch (err) {
      setPhase('unknown')
      setDetail(`强制更新失败：${err instanceof Error ? err.message : String(err)}`)
      scheduleHide(12000)
    }
  }

  const handleClick = () => {
    if (phase === 'checking' || phase === 'applying') return
    if (phase === 'available') void doApply()
    else void runCheck()
  }

  const busy = phase === 'checking' || phase === 'applying'
  const open = phase !== 'idle' && phase !== 'checking'
  const showDot = autoAvailable || phase === 'available'

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        className="btn btn-sm btn-secondary"
        onClick={handleClick}
        disabled={busy}
        title="检查页面版本并更新（主动比对远端 version.json）；弹窗内可强制更新"
        aria-label="检查页面版本并更新"
        style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <CloudDownloadIcon pulse={busy} />
        <span>{phase === 'checking' ? '检查中…' : phase === 'applying' ? '更新中…' : '检查更新'}</span>
        {showDot && (
          <span
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--success, #3fb950)',
              boxShadow: '0 0 6px var(--success, #3fb950)',
            }}
          />
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            zIndex: 120,
            width: 300,
            maxWidth: 'calc(100vw - 24px)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            padding: '10px 12px',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
              {phase === 'available' && (result?.message || '发现新版本')}
              {phase === 'latest' && (result?.message || '已是最新版本')}
              {phase === 'unknown' && (detail || '无法确认是否有更新')}
              {phase === 'applying' && (detail || '正在应用更新…')}
              {(phase === 'available' || phase === 'latest') && result && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                  本机 {result.local.sha || '?'} · {result.local.buildTime || '未知时间'}
                  {result.remote && phase === 'available' ? ` → 远端 ${result.remote.sha || '?'}` : ''}
                </div>
              )}
            </div>
            {!busy && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  if (hideTimer.current) clearTimeout(hideTimer.current)
                  setPhase('idle')
                }}
                title="关闭"
                style={{ padding: '0 6px', lineHeight: '18px' }}
              >
                ×
              </button>
            )}
          </div>

          {phase === 'available' && (
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  if (hideTimer.current) clearTimeout(hideTimer.current)
                  setPhase('idle')
                }}
              >
                稍后
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => void doApply()}>
                立即更新
              </button>
            </div>
          )}

          {(phase === 'unknown' || phase === 'latest' || phase === 'available') && (
            <div
              style={{
                marginTop: 8,
                paddingTop: 8,
                borderTop: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: 'var(--text-muted)',
              }}
            >
              <span>页面内容仍是旧的？</span>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => void doForce()}
                title="注销 Service Worker、清空全部缓存后强制重载"
              >
                强制更新
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
