import 'server-only';
import path from 'node:path';
import { config } from '@/platform/config';
import { LocalFileStore } from './local-store';
import type { FileStore } from './types';

export * from './types';
export * from './validation';
export { LocalFileStore } from './local-store';

/**
 * The store the application uses.
 *
 * Local disk today. An S3-compatible adapter implements the same three methods and is selected
 * here; nothing else in the codebase names a storage backend, so adding one is a change to this
 * file rather than to the payment workflow.
 */
let override: FileStore | null = null;
let cached: FileStore | null = null;

export function fileStore(): FileStore {
  if (override) return override;
  if (cached) return cached;

  const root = path.resolve(process.cwd(), config().FILE_STORAGE_DIR);
  cached = new LocalFileStore(root);
  return cached;
}

/** Test seam. Pass null to restore the configured store. */
export function setFileStoreOverride(store: FileStore | null): void {
  override = store;
  if (store === null) cached = null;
}
