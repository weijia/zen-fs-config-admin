/**
 * vitest 全局 setup。
 *
 * React 19 要求显式声明处于 act 环境，否则每次 `act()` 都会打印
 * "The current testing environment is not configured to support act(...)"。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
