// 版本信息 — CI 构建时通过环境变量注入
// 本地开发时显示 dev / 当前时间 / local

export const VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
export const BUILD_TIME = import.meta.env.VITE_APP_BUILD_TIME || new Date().toISOString()
export const COMMIT_SHA = import.meta.env.VITE_APP_COMMIT_SHA || 'local'

export const versionDisplay = `${VERSION} (${COMMIT_SHA})`
export const buildTimeDisplay = new Date(BUILD_TIME).toLocaleString('zh-CN')