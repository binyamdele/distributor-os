import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { log } from '@/platform/observability/logger';
import type { FileMetadata, FileStore, PutInput, StoreHealth, StoredFile } from './types';

/**
 * S3-compatible storage for payment evidence.
 *
 * The production implementation of the interface Phase 5 designed. Everything that made that
 * interface unusual is what makes this adapter safe:
 *
 *   - **There is still no URL method.** No presigned link is generated anywhere, so no path
 *     exists by which a bucket object could be handed to a browser directly. Every read goes
 *     back through the application route that checks the session, the permission and the tenant
 *     first. A presigned URL is a bearer token for a bank slip; once issued it works for anybody
 *     holding it, for as long as it lives, and it cannot be revoked. Proxying costs a few
 *     hundred kilobytes of transfer per view and removes that entire class of mistake.
 *   - **Keys are invented here**, never derived from a filename. `organizations/<org>/payments/
 *     <uuid>` — the org prefix means a misconfigured bucket policy fails visibly rather than
 *     quietly mixing tenants, and the uuid means evidence cannot be found by guessing a customer
 *     name or an order number.
 *   - **Possession of a key grants nothing.** Authorization is a database ownership check in the
 *     read route; this class is only ever reached after it has passed.
 *
 * Works against AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2 and MinIO. The pilot
 * has been integration-tested against MinIO, which speaks the same protocol.
 */

export interface S3StoreOptions {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Set for anything that is not AWS S3 — R2, Spaces, MinIO. */
  readonly endpoint?: string;
  /**
   * Address the bucket as a path segment rather than a subdomain.
   *
   * Required by MinIO and by most self-hosted gateways, because virtual-host addressing needs
   * wildcard DNS that they do not have. AWS and R2 prefer the default.
   */
  readonly forcePathStyle?: boolean;
  /** Milliseconds. A storage provider that stops answering must not hold a request open. */
  readonly timeoutMs?: number;
  /**
   * Ask for server-side encryption on every object.
   *
   * Off by default, and that default was earned: an earlier version sent `AES256`
   * unconditionally, on the assumption that a provider without support would ignore the header.
   * MinIO does not ignore it — it refuses the upload outright with "KMS is not configured", so
   * every single evidence upload would have failed on any provider not set up for SSE.
   *
   * Bucket-level default encryption is the better mechanism regardless: it is configured once on
   * the bucket, applies to everything written including by other tools, and does not depend on
   * every client remembering a header. This flag exists for a provider that requires the header
   * explicitly, and the deployment runbook asks for bucket-level encryption instead.
   */
  readonly serverSideEncryption?: 'AES256' | 'aws:kms';
}

/**
 * The metadata key the content hash is stored under.
 *
 * S3 lowercases user metadata keys and returns them without the `x-amz-meta-` prefix, so this is
 * the name that comes back from a HEAD. Storing the hash as metadata means `getMetadata` can
 * answer without downloading the object — which matters because the alternative is pulling every
 * bank slip over the network to compute a digest the uploader already computed.
 */
const HASH_METADATA_KEY = 'content-sha256';

export class S3FileStore implements FileStore {
  readonly name = 's3';

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly serverSideEncryption?: 'AES256' | 'aws:kms';

  constructor(options: S3StoreOptions) {
    this.bucket = options.bucket;
    this.serverSideEncryption = options.serverSideEncryption;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      requestHandler: {
        requestTimeout: options.timeoutMs ?? 15_000,
        connectionTimeout: 5_000,
      },
      // Three attempts, then fail. A storage blip should be survived; a storage outage should be
      // reported rather than retried until the request times out.
      maxAttempts: 3,
    });
  }

  /**
   * Opaque, tenant-prefixed, and never derived from anything the uploader supplied.
   *
   * The `payments/` segment exists so a future retention policy — or a bucket lifecycle rule —
   * can act on evidence without needing to know which objects are evidence.
   */
  private newKey(organizationId: string): string {
    return `organizations/${organizationId}/payments/${randomUUID()}`;
  }

  /**
   * Does this look like a key this store issued?
   *
   * Keys are always generated by `newKey` and are looked up in the database before they reach
   * here, so in practice nothing malformed arrives. This is defence against a future refactor,
   * and it closes two things the contract suite found by asking a real server:
   *
   *   - an **empty key** made MinIO return a *successful* response with a body. A store that
   *     hands back bytes for `read('')` is one small mistake away from being an information
   *     disclosure, whatever the current callers happen to do.
   *   - `../../etc/passwd` produced a 400, which propagated as a thrown error rather than the
   *     null the local store returns. Two implementations of one interface behaving differently
   *     on bad input is exactly what the shared contract exists to prevent.
   *
   * Checked without a network call, so a bad key costs nothing.
   */
  private isWellFormed(key: string): boolean {
    return /^organizations\/[0-9a-fA-F-]{36}\/payments\/[0-9a-fA-F-]{36}$/.test(key);
  }

  async put(input: PutInput): Promise<StoredFile> {
    const key = this.newKey(input.organizationId);
    const contentHash = createHash('sha256').update(input.bytes).digest('hex');

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: input.mimeType,
        /*
         * The hash travels with the object.
         *
         * The database also records it, and that is the authority. This copy is what makes a
         * restore drill able to answer "do the bytes in the bucket still match what the database
         * says" without trusting either side to describe the other.
         */
        Metadata: { [HASH_METADATA_KEY]: contentHash },
        /*
         * No ACL is sent at all.
         *
         * A bucket with Block Public Access on — which the deployment runbook requires — refuses
         * any ACL outright, including `private`. Omitting it means the bucket's own policy is
         * the single place object visibility is decided, which is where it belongs.
         */
        ServerSideEncryption: this.serverSideEncryption,
      }),
    );

    return {
      key,
      contentHash,
      sizeBytes: input.bytes.byteLength,
      mimeType: input.mimeType,
    };
  }

  async getMetadata(key: string): Promise<FileMetadata | null> {
    if (!this.isWellFormed(key)) return null;

    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));

      const stored = head.Metadata?.[HASH_METADATA_KEY];

      return {
        key,
        sizeBytes: head.ContentLength ?? 0,
        /*
         * The stored hash, or an empty string when an object predates this adapter.
         *
         * Deliberately not computed by downloading the object: a caller asking for metadata is
         * asking a cheap question, and silently turning it into a full transfer of every bank
         * slip would be a surprising cost. A caller that needs to verify bytes reads them.
         */
        contentHash: stored ?? '',
      };
    } catch (error) {
      // A missing object is a legitimate answer, not a failure. Anything else — 403, a timeout,
      // a wrong bucket — is a genuine problem and must not be flattened into "not found",
      // because that would make a credentials mistake look like an empty store.
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async read(key: string): Promise<Uint8Array | null> {
    if (!this.isWellFormed(key)) return null;

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;

      // Buffered whole. Evidence is a slip photograph capped at 10 MB by the upload validator,
      // not a video, and the read route returns it as one response anyway.
      const bytes = await response.Body.transformToByteArray();
      return bytes;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // Silently ignored rather than refused, matching the local store: deleting something that
    // was never there is not an error a retention job should stop on.
    if (!this.isWellFormed(key)) return;
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Is the bucket reachable and are the credentials good?
   *
   * `HeadBucket` rather than probing for a nonexistent object, because the two failures must not
   * be confused: a 404 on an object means a healthy bucket, while a 403 means the credentials
   * are wrong and a timeout means the network is. Probing an object and treating any error as
   * unhealthy would report a perfectly good bucket as broken.
   */
  async health(): Promise<StoreHealth> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { reachable: true };
    } catch (error) {
      const detail = classify(error);

      /*
       * The response says a category; the log says why.
       *
       * These must stay separate. The readiness endpoint is the most-probed URL a deployment has
       * and is reachable before authentication, so it names no host, bucket or credential — but
       * an operator staring at `unreachable` has nowhere to go, and diagnosing one such failure
       * cost a full deploy cycle. The log is server-side, already redacted, and is where this
       * belongs.
       *
       * The error's `name` and the host it tried are the two facts that identify the problem:
       * a wrong endpoint, a missing bucket and virtual-host addressing against a provider that
       * only serves path-style all look identical from outside and completely different here.
       */
      log.warn({
        event: 'file_store.unreachable',
        detail,
        reason: error instanceof Error ? error.name : 'unknown',
        // Host only, never the key, the signature or the full URL.
        host: hostOf(error),
      });

      return { reachable: false, detail };
    }
  }
}

/**
 * The hostname the SDK actually tried, dug out of whatever the failure carried.
 *
 * It is the single most useful fact when a store is unreachable, because it distinguishes the
 * two configurations that otherwise look the same: `bucket.project.supabase.co` means
 * virtual-host addressing was used against a provider that only serves path-style, and
 * `project.supabase.co` means addressing was right and something else is wrong.
 */
function hostOf(error: unknown): string {
  const candidate = error as { hostname?: string; message?: string };
  if (candidate?.hostname) return candidate.hostname;

  const match = /([a-z0-9-]+(?:.[a-z0-9-]+)+)/i.exec(candidate?.message ?? '');
  return match?.[1] ?? 'unknown';
}

function statusOf(error: unknown): number | undefined {
  const withMeta = error as { $metadata?: { httpStatusCode?: number }; name?: string };
  return withMeta?.$metadata?.httpStatusCode;
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'NotFound' || name === 'NoSuchKey' || statusOf(error) === 404;
}

/**
 * A category, never a message.
 *
 * The health endpoint is the most-probed URL a deployment has and is reachable before
 * authentication. An SDK error message can contain the bucket name, the endpoint host and
 * occasionally part of a request signature, none of which belongs in a public response.
 */
function classify(error: unknown): StoreHealth['detail'] {
  const status = statusOf(error);
  const name = (error as { name?: string })?.name ?? '';

  if (status === 403 || name === 'AccessDenied' || name === 'InvalidAccessKeyId') {
    return 'unauthorized';
  }
  if (status === 404 || name === 'NoSuchBucket') return 'missing-bucket';
  if (name === 'TimeoutError' || name === 'RequestTimeout' || /timeout/i.test(name)) {
    return 'timeout';
  }
  return 'unreachable';
}
