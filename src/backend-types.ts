import { getBackendMetadata, listBackendMetadata, type BackendMetadata } from 'zen-fs-config';

export type { BackendMetadata };

/**
 * Get metadata for a registered backend type.
 * Returns undefined if the type is not registered.
 */
export function getBackendTypeDef(type: string): BackendMetadata | undefined {
  return getBackendMetadata(type);
}

/**
 * List all registered backend types with their metadata.
 * Only returns backends that were registered with metadata.
 */
export function getBackendTypes(): BackendMetadata[] {
  return listBackendMetadata();
}
