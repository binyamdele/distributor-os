/**
 * File storage.
 *
 * Payment evidence is a photograph of a bank slip: it contains account numbers, names,
 * references and balances. Three rules follow, and they shape this interface:
 *
 *   1. **Content addresses identity, not the filename.** A caller stores bytes and receives an
 *      opaque key plus a SHA-256 of what was actually written. Filenames are display text; they
 *      are attacker-controlled, they collide, and they can carry path separators.
 *   2. **Nothing is served from a public directory.** There is no URL on this interface. Every
 *      read goes back through the application, which checks the session, the tenant and the
 *      permission first.
 *   3. **Deletion is deliberate.** A confirmation refers to specific bytes, so removing them
 *      orphans an approval. `delete` exists for a retention policy that does not exist yet.
 */

export interface StoredFile {
  /** Opaque storage key. Not a path, not guessable, never shown to a user. */
  readonly key: string;
  /** SHA-256 of the stored bytes, hex. The identity a confirmation binds to. */
  readonly contentHash: string;
  readonly sizeBytes: number;
  /** Detected from the bytes, not taken from the upload's claim. */
  readonly mimeType: string;
}

export interface FileMetadata {
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentHash: string;
}

export interface PutInput {
  readonly bytes: Uint8Array;
  /** The detected MIME type. Callers must have validated it against the bytes. */
  readonly mimeType: string;
  /**
   * A tenant prefix, so one organization's objects are grouped and a misconfigured bucket
   * policy fails visibly rather than silently mixing tenants.
   */
  readonly organizationId: string;
}

/**
 * Whether the store itself is reachable, as distinct from whether an object exists.
 *
 * The distinction only became load-bearing with a remote store. On local disk "I cannot find
 * that file" and "I cannot reach the disk" are nearly the same event. Against S3 they are
 * completely different: a 404 means the bucket is healthy and the object is not there, while a
 * 403 means the credentials are wrong and a timeout means the network is. Probing for a
 * nonexistent key and treating any failure as unhealthy would have reported a perfectly good
 * bucket as broken, so the store is asked directly.
 */
export interface StoreHealth {
  readonly reachable: boolean;
  /** Safe to surface on a health endpoint: a category, never a message, host or credential. */
  readonly detail?: 'unreachable' | 'unauthorized' | 'missing-bucket' | 'timeout';
}

export interface FileStore {
  readonly name: string;
  put(input: PutInput): Promise<StoredFile>;
  getMetadata(key: string): Promise<FileMetadata | null>;
  /** Reads the whole object. Evidence is a slip photo, not a video; streaming is not needed. */
  read(key: string): Promise<Uint8Array | null>;
  /** Only for a retention policy. Not called anywhere in Phase 5. */
  delete(key: string): Promise<void>;
  /** Can this store be reached and used at all? Never confused with "does this object exist". */
  health(): Promise<StoreHealth>;
}
