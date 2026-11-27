/**
 * 更新状态的极简共享存储：自动检查（UpdateToast）与手动检查（UpdateCheckButton）共用，
 * 这样任一通道发现新版本时，顶部按钮上的小圆点与提示条都能保持一致。
 */
import type { UpdateCheckResult } from './update-check'

export interface UpdateSnapshot {
  available: boolean
  result: UpdateCheckResult | null
}

type Listener = (snapshot: UpdateSnapshot) => void

let snapshot: UpdateSnapshot = { available: false, result: null }
const listeners = new Set<Listener>()

function emit() {
  for (const fn of listeners) fn(snapshot)
}

export function versionKey(result: UpdateCheckResult): string {
  if (result.remote) return `${result.remote.sha || ''}|${result.remote.buildTime || ''}|${result.remote.version || ''}`
  return `sw-waiting|${result.local.sha || ''}`
}

export function setUpdateAvailable(result: UpdateCheckResult) {
  snapshot = { available: true, result }
  emit()
}

export function clearUpdateAvailable() {
  if (!snapshot.available && !snapshot.result) return
  snapshot = { available: false, result: null }
  emit()
}

export function getUpdateSnapshot(): UpdateSnapshot {
  return snapshot
}

export function subscribeUpdate(fn: Listener): () => void {
  listeners.add(fn)
  fn(snapshot)
  return () => {
    listeners.delete(fn)
  }
}
