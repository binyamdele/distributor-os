import 'server-only';
import path from 'node:path';
import { config } from '@/platform/config';
import { LocalFileStore } from './local-store';
import { S3FileStore } from './s3-store';
import type { FileStore } from './types';

export * from './types';
export * from './validation';
export { LocalFileStore } from './local-store';
export { S3FileStore, type S3StoreOptions } from './s3-store';

/**
 * The store the application uses.
 *
 * Selected here and nowhere else. No module outside this directory names a storage backend, so
 * adding S3 was a change to this one function rather than to the payment workflow — which is
 * what the abstraction was for.
 *
 * The production config refuses `local` outright: a container filesystem is ephemeral, and
 * evidence written to one vanishes on restart leaving payment rows pointing at bank slips that
 * no longer exist.
 */
let override: FileStore | null = null;
let cached: FileStore | null = null;

export function fileStore(): FileStore {
  if (override) return override;
  if (cached) return cached;

  const settings = config();

  if (settings.FILE_STORAGE_DRIVER === 's3') {
    cached = new S3FileStore({
      // Non-null: the config layer refuses an s3 driver with any of these missing, so reaching
      // here without them is impossible rather than merely unlikely.
      bucket: settings.S3_BUCKET!,
      region: settings.S3_REGION!,
      accessKeyId: settings.S3_ACCESS_KEY_ID!,
      secretAccessKey: settings.S3_SECRET_ACCESS_KEY!,
      endpoint: settings.S3_ENDPOINT,
      forcePathStyle: settings.S3_FORCE_PATH_STYLE,
    });
    return cached;
  }

  const root = path.resolve(process.cwd(), settings.FILE_STORAGE_DIR);
  cached = new LocalFileStore(root);
  return cached;
}

/** Test seam. Pass null to restore the configured store. */
export function setFileStoreOverride(store: FileStore | null): void {
  override = store;
  if (store === null) cached = null;
}
