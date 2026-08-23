import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileMetadata, FileStore, PutInput, StoreHealth, StoredFile } from './types';

/**
 * Local-disk store for development and for the pilot.
 *
 * Writes under `FILE_STORAGE_DIR`, which is git-ignored — payment evidence must never end up in
 * a repository. The directory sits outside `public/`, so Next serves nothing from it: reads go
 * through the application, which checks the session and the tenant first.
 *
 * Keys are `<organizationId>/<uuid>`. The organization prefix means a misconfigured bucket
 * policy on a future S3 adapter fails visibly rather than quietly mixing tenants, and the uuid
 * means an evidence file cannot be found by guessing a customer name or an order number.
 */
export class LocalFileStore implements FileStore {
  readonly name = 'local';

  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    // Keys are generated here and never come from a client, but a store that resolves whatever
    // it is handed is one refactor away from being a path-traversal bug.
    const normalized = path.posix.normalize(key);
    if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
      throw new Error(`refusing an unsafe storage key: ${key}`);
    }
    const full = path.resolve(this.rootDir, normalized);
    if (!full.startsWith(path.resolve(this.rootDir))) {
      throw new Error(`refusing a storage key that escapes the root: ${key}`);
    }
    return full;
  }

  async put(input: PutInput): Promise<StoredFile> {
    const key = `${input.organizationId}/${randomUUID()}`;
    const target = this.resolve(key);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.bytes);

    return {
      key,
      contentHash: createHash('sha256').update(input.bytes).digest('hex'),
      sizeBytes: input.bytes.byteLength,
      mimeType: input.mimeType,
    };
  }

  async getMetadata(key: string): Promise<FileMetadata | null> {
    try {
      const target = this.resolve(key);
      const info = await stat(target);
      const bytes = await readFile(target);
      return {
        key,
        sizeBytes: info.size,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch {
      return null;
    }
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.resolve(key)));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  /**
   * Can the root directory be written to?
   *
   * Checked by creating it, which is idempotent and is exactly what `put` will need to do. A
   * read-only mount or a full disk fails here rather than on the first upload.
   */
  async health(): Promise<StoreHealth> {
    try {
      await mkdir(this.rootDir, { recursive: true });
      return { reachable: true };
    } catch {
      return { reachable: false, detail: 'unreachable' };
    }
  }
}
