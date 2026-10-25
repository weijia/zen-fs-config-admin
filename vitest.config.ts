import { defineConfig } from 'vitest/config';

/**
 * vitest 配置（admin 此前没有测试框架，按「以仓库现有为准」补上 vitest）。
 *
 * `__ZEN_FS_GITEE_VERSION__` 由 vite.config.ts 的 `define` 注入；
 * 测试环境下同样需要注入，否则 `register-backends.ts` 在模块加载时
 * 会因该全局变量未定义而抛 ReferenceError。
 */
export default defineConfig({
  define: {
    __ZEN_FS_GITEE_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/__tests__/setup.ts'],
    globals: true,
  },
});
