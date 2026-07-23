import type { BackendDescriptor } from 'zen-fs-config';
import { getBackendTypeDef } from './backend-types';

/**
 * Serialize a backend descriptor into a one-line config string.
 * Format: type:id:key=value,key=value,desc=description
 * Example: GitHub:my-repo:owner=weijia,repo=zen-fs-config,branch=main
 */
export function serializeBackend(b: BackendDescriptor): string {
  const opts = Object.entries(b.options ?? {})
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const parts = [b.type, b.id];
  if (opts) parts.push(opts);
  if (b.description) parts.push(`desc=${b.description}`);
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
 */
export function deserializeBackend(str: string): { type: string; id: string; options: Record<string, string>; description: string } | null {
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
  if (optionsStr) {
    for (const pair of optionsStr.split(',')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (key === 'desc') {
        description = value;
      } else {
        options[key] = value;
      }
    }
  }

  return { type, id, options, description };
}
