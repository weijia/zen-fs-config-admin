import { useState, useEffect } from 'react'

// 去重标志：updatefound 和 updated 都可能触发，确保只通知一次
let updateAvailable = false

export default function UpdateToast() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const handleUpdate = (reg: ServiceWorkerRegistration) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing
        if (!newWorker) return

        newWorker.addEventListener('statechange', () => {
          // 新 Worker 已安装且等待中，只通知一次
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            if (!updateAvailable) {
              updateAvailable = true
              console.log('[PWA] 新版本可用')
              setShow(true)
            }
          }
        })
      })
    }

    // 注册后监听更新
    navigator.serviceWorker.ready.then((reg) => {
      handleUpdate(reg)
      // 3 秒后检查更新
      setTimeout(() => reg.update().catch(console.error), 3000)
    })

    // 每 5 分钟轮询
    const interval = setInterval(() => {
      navigator.serviceWorker.ready.then((reg) => reg.update().catch(console.error))
    }, 5 * 60 * 1000)

    return () => clearInterval(interval)
  }, [])

  const handleRefresh = async () => {
    const reg = await navigator.serviceWorker.ready
    const newWorker = reg.waiting
    if (newWorker) {
      // 发送消息让新 SW 跳过等待 —— 需要自定义 SW 监听此消息
      newWorker.postMessage({ type: 'SKIP_WAITING' })
      // 新 SW 激活后刷新页面
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload()
      })
    }
    setShow(false)
  }

  if (!show) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '40px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 200,
        animation: 'slideIn 0.2s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          padding: '12px 20px',
          borderRadius: '8px',
          border: '1px solid var(--border)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}
      >
        <span style={{ fontSize: '13px' }}>新版本可用</span>
        <button
          onClick={handleRefresh}
          style={{
            padding: '6px 14px',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 'var(--radius)',
            fontSize: '13px',
            fontWeight: 500,
            border: 'none',
            cursor: 'pointer',
          }}
        >
          点击刷新
        </button>
      </div>
    </div>
  )
}