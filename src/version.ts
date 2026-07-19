// 版本信息 — 构建时由 vite.config.ts 的 define 注入
// CI 构建时通过环境变量 VITE_APP_VERSION / VITE_APP_BUILD_TIME / VITE_APP_COMMIT_SHA 覆盖

declare const __APP_BUILD_TIME__: string;

export const VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
export const BUILD_TIME = import.meta.env.VITE_APP_BUILD_TIME || __APP_BUILD_TIME__ || new Date().toISOString()
export const COMMIT_SHA = import.meta.env.VITE_APP_COMMIT_SHA || 'local'

export const versionDisplay = `${VERSION} (${COMMIT_SHA})`
export const buildTimeDisplay = new Date(BUILD_TIME).toLocaleString('zh-CN')