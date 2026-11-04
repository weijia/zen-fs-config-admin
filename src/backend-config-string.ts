import type { BackendDescriptor, AppDataBackendDescriptor } from 'zen-fs-config';
import { getBackendTypeDef } from './backend-types';

/**
 * Serialize a backend descriptor into a one-line config string.
 * Format: type:id:key=value,key=value,desc=description[,accountBackendId=id]
 * Example: GitHub:my-repo:owner=weijia,repo=zen-fs-config,branch=main
 *
 * Accepts both config-sync backends (BackendDescriptor) and data-sync-group
 * backends (AppDataBackendDescriptor). For the latter, the optional
 * `accountBackendId` field is written as a reserved segment (it tells the
 * data group to reuse a config-sync backend's account credentials).
 *
 * `createdAt` (data-group internal dedup timestamp) is intentionally NOT
 * serialized — callers reset it to Date.now() on import.
 */
export function serializeBackend(b: BackendDescriptor | AppDataBackendDescriptor): string {
  const opts = Object.entries(b.options ?? {})
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const parts = [b.type, b.id];
  if (opts) parts.push(opts);
  if (b.description) parts.push(`desc=${b.description}`);
  const accountBackendId = (b as AppDataBackendDescriptor).accountBackendId;
  if (accountBackendId) parts.push(`accountBackendId=${accountBackendId}`);
  return parts.join(':');
}

/**
 * Deserialize a config string into a partial backend descriptor.
 * Returns null if the string is not a valid config string.
 *
 * Format: type:id:key=value,key=value
 * - type must be a known backend type
 * - id is required
 * - options are optional, defaults are merged in
 * - `desc` is the reserved key for description
 * - `accountBackendId` is the reserved key for data-sync-group account reuse
 */
export function deserializeBackend(str: string): {
  type: string;
  id: string;
  options: Record<string, string>;
  description: string;
  accountBackendId?: string;
} | null {
  const trimmed = str.trim();
  if (!trimmed) return null;

  const firstColon = trimmed.indexOf(':');
  if (firstColon < 0) return null;
  const type = trimmed.slice(0, firstColon);
  const def = getBackendTypeDef(type);
  if (!def) return null;

  const rest = trimmed.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  let id: string;
  let optionsStr: string;
  if (secondColon < 0) {
    id = rest;
    optionsStr = '';
  } else {
    id = rest.slice(0, secondColon);
    optionsStr = rest.slice(secondColon + 1);
  }

  if (!id.trim()) return null;

  const options: Record<string, string> = { ...def.defaultOptions };
  let description = '';
  let accountBackendId: string | undefined;
  if (optionsStr) {
    for (const pair of optionsStr.split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (key === 'desc') {
        description = value;
      } else if (key === 'accountBackendId') {
        accountBackendId = value;
      } else {
        options[key] = value;
      }
    }
  }

  return { type, id, options, description, accountBackendId };
}
