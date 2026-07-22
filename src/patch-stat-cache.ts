/**
 * Stat cache patch — no longer needed.
 *
 * Previously, CachedFileSystem would JSON-serialize stat results, losing
 * isFile()/isDirectory() methods. This patch re-hydrated them.
 *
 * Now that all stat results use `mode` (a plain number) for type detection,
 * serialization works naturally and no patching is required.
 */
export function patchStatCache(): void {
  // No-op — mode-based stat is JSON-safe.
}
