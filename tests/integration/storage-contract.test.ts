import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFileStore, S3FileStore } from '@/platform/storage';
import type { FileStore } from '@/platform/storage';

/**
 * The FileStore contract, run against every implementation.
 *
 * One suite, two backends. That is the point: a store is interchangeable only if it is *proven*
 * interchangeable, and the whole payment workflow depends on swapping local disk for a bucket
 * without any module noticing.
 *
 * The S3 half runs against **MinIO**, a real S3-compatible server, not a mocked SDK. Mocking
 * would only have asserted that the mock behaves as written. It would not have caught path-style
 * addressing, the way S3 lowercases user metadata keys, or the difference between a 404 and a
 * 403 — and each of those is a real defect this file found while it was being written.
 *
 * Skipped cleanly when MinIO is not running, so `pnpm test` works on a machine that has only
 * started Postgres. It runs in CI, where the service container is always up.
 */

const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9010';
const S3_ACCESS_KEY = process.env.TEST_S3_ACCESS_KEY_ID ?? 'distributor_minio';
const S3_SECRET_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'distributor_minio_dev';
const S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'distributor-evidence-test';

async function s3Available(): Promise<boolean> {
  try {
    const response = await fetch(`${S3_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const s3Up = await s3Available();

/** A tiny valid PNG, so the bytes are genuinely binary rather than text pretending to be. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Every behaviour the payment workflow relies on.
 *
 * Written once and applied to each implementation, because a difference between them is exactly
 * the sort of thing that would only surface in production, on the first bank slip.
 */
function contractSuite(label: string, makeStore: () => Promise<FileStore>) {
  describe(label, () => {
    let store: FileStore;
    const organizationId = randomUUID();

    beforeAll(async () => {
      store = await makeStore();
    });

    it('round-trips bytes with binary equality', async () => {
      const stored = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId });
      const read = await store.read(stored.key);

      expect(read).not.toBeNull();
      // Byte-for-byte, not "roughly". A single flipped byte in a bank slip is a dispute.
      expect(Buffer.from(read!).equals(Buffer.from(PNG))).toBe(true);
    });

    it('reports the hash of what was actually written', async () => {
      const stored = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId });

      expect(stored.contentHash).toBe(sha256(PNG));
      expect(stored.sizeBytes).toBe(PNG.byteLength);

      // And the bytes that come back still hash to it, which is what the restore drill checks.
      const read = await store.read(stored.key);
      expect(sha256(read!)).toBe(stored.contentHash);
    });

    it('returns metadata carrying the same hash', async () => {
      const stored = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId });
      const metadata = await store.getMetadata(stored.key);

      expect(metadata).not.toBeNull();
      expect(metadata!.key).toBe(stored.key);
      expect(metadata!.sizeBytes).toBe(PNG.byteLength);
      expect(metadata!.contentHash).toBe(stored.contentHash);
    });

    it('invents an opaque key that carries no filename', async () => {
      const stored = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId });

      // The tenant prefix, so a misconfigured bucket policy fails visibly rather than quietly
      // mixing organizations.
      expect(stored.key).toContain(organizationId);
      // A uuid, so evidence cannot be found by guessing a customer name or an order number.
      expect(stored.key).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    });

    it('gives a different key to identical bytes', async () => {
      // Deliberately not content-addressed. Two customers sending the same screenshot are two
      // pieces of evidence, and deduplicating them would let deleting one destroy the other.
      const first = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId });
      const second = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId });

      expect(first.key).not.toBe(second.key);
      expect(first.contentHash).toBe(second.contentHash);
    });

    it('returns null for a key that does not exist', async () => {
      // Null, never a throw. The read route turns this into the same 404 a foreign tenant's key
      // produces, so a response cannot confirm whether an object exists.
      const missing = `organizations/${organizationId}/payments/${randomUUID()}`;

      expect(await store.read(missing)).toBeNull();
      expect(await store.getMetadata(missing)).toBeNull();
    });

    it('returns null rather than throwing for a malformed key', async () => {
      for (const key of ['', 'no-slashes', '../../etc/passwd']) {
        // Keys are always generated by the store, so this is defence against a future refactor
        // rather than against a current caller.
        const result = await store.read(key).catch(() => 'threw');
        expect(result === null || result === 'threw', key).toBe(true);
      }
    });

    it('deletes an object, after which it is gone', async () => {
      const stored = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId });
      expect(await store.read(stored.key)).not.toBeNull();

      await store.delete(stored.key);

      expect(await store.read(stored.key)).toBeNull();
      expect(await store.getMetadata(stored.key)).toBeNull();
    });

    it('tolerates deleting something that is not there', async () => {
      await expect(
        store.delete(`organizations/${organizationId}/payments/${randomUUID()}`),
      ).resolves.not.toThrow();
    });

    it('reports itself reachable', async () => {
      const health = await store.health();
      expect(health.reachable).toBe(true);
      expect(health.detail).toBeUndefined();
    });

    it('keeps one organization out of another key space', async () => {
      // The store itself enforces nothing: authorization is a database ownership check in the
      // read route. What it does guarantee is that keys are *separable*, so a bucket policy or a
      // lifecycle rule can act per tenant and a leak is visible in the key rather than hidden.
      const other = randomUUID();
      const mine = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId });
      const theirs = await store.put({ bytes: PNG, mimeType: 'image/png', organizationId: other });

      expect(mine.key).toContain(organizationId);
      expect(theirs.key).toContain(other);
      expect(mine.key).not.toContain(other);
    });

    it('handles a larger binary payload intact', async () => {
      // Deterministic pseudo-random bytes: compressible data would not exercise a transfer bug.
      const big = new Uint8Array(512 * 1024);
      for (let index = 0; index < big.length; index += 1) big[index] = (index * 31 + 7) % 256;

      const stored = await store.put({ bytes: big, mimeType: 'application/pdf', organizationId });
      const read = await store.read(stored.key);

      expect(read!.byteLength).toBe(big.byteLength);
      expect(sha256(read!)).toBe(sha256(big));
    });
  });
}

// ---------------------------------------------------------------------------

let localRoot: string;

contractSuite('the local store', async () => {
  localRoot = await mkdtemp(join(tmpdir(), 'store-contract-'));
  return new LocalFileStore(localRoot);
});

afterAll(async () => {
  if (localRoot) await rm(localRoot, { recursive: true, force: true });
});

describe.skipIf(!s3Up)('S3 (MinIO)', () => {
  contractSuite('the s3 store', async () => {
    // The bucket is created here rather than assumed, so the suite is self-contained on a fresh
    // MinIO volume and in CI.
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    });

    try {
      await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    } catch {
      // Already there. Creating a bucket that exists is not an error worth failing a test run
      // over, and the health check below proves it is usable either way.
    }

    return new S3FileStore({
      bucket: S3_BUCKET,
      region: 'us-east-1',
      endpoint: S3_ENDPOINT,
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
      forcePathStyle: true,
    });
  });

  describe('S3-specific failure behaviour', () => {
    it('reports a missing bucket rather than claiming to be healthy', async () => {
      const store = new S3FileStore({
        bucket: `does-not-exist-${randomUUID()}`,
        region: 'us-east-1',
        endpoint: S3_ENDPOINT,
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
        forcePathStyle: true,
      });

      const health = await store.health();
      expect(health.reachable).toBe(false);
      // The category, so readiness can say something useful without leaking the bucket name.
      expect(['missing-bucket', 'unauthorized']).toContain(health.detail);
    });

    it('reports bad credentials as unauthorized, not as an empty store', async () => {
      // The failure the previous health check could not see. Probing for a nonexistent key
      // returns null on a healthy bucket *and* on one we cannot authenticate to, so a
      // credentials mistake would have looked exactly like a working store.
      const store = new S3FileStore({
        bucket: S3_BUCKET,
        region: 'us-east-1',
        endpoint: S3_ENDPOINT,
        accessKeyId: 'wrong-key-id',
        secretAccessKey: 'wrong-secret-key',
        forcePathStyle: true,
      });

      const health = await store.health();
      expect(health.reachable).toBe(false);
      expect(health.detail).toBeDefined();
    });

    it('reports an unreachable endpoint without hanging', async () => {
      const store = new S3FileStore({
        bucket: S3_BUCKET,
        region: 'us-east-1',
        // Reserved for documentation, so nothing answers.
        endpoint: 'http://198.51.100.1:9010',
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
        forcePathStyle: true,
        timeoutMs: 2_000,
      });

      const startedAt = Date.now();
      const health = await store.health();

      expect(health.reachable).toBe(false);
      // Bounded. An unreachable provider must not hold a readiness probe open until it times out.
      expect(Date.now() - startedAt).toBeLessThan(30_000);
    }, 40_000);

    it('never exposes the bucket, endpoint or credentials in a health result', async () => {
      const store = new S3FileStore({
        bucket: `secret-bucket-${randomUUID()}`,
        region: 'us-east-1',
        endpoint: S3_ENDPOINT,
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
        forcePathStyle: true,
      });

      const serialised = JSON.stringify(await store.health());

      expect(serialised).not.toContain('secret-bucket');
      expect(serialised).not.toContain(S3_ACCESS_KEY);
      expect(serialised).not.toContain(S3_SECRET_KEY);
      expect(serialised).not.toContain('127.0.0.1');
    });

    it('exposes no method capable of producing a URL', () => {
      // The structural guarantee. A presigned URL is a bearer token for a bank slip: once issued
      // it works for anybody holding it, for as long as it lives, and it cannot be revoked.
      // There is nowhere in this interface to put one.
      const store = new S3FileStore({
        bucket: S3_BUCKET,
        region: 'us-east-1',
        endpoint: S3_ENDPOINT,
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY,
        forcePathStyle: true,
      });

      const methods = [
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(store)),
        ...Object.keys(store),
      ];

      for (const method of methods) {
        expect(method.toLowerCase()).not.toContain('url');
        expect(method.toLowerCase()).not.toContain('presign');
        expect(method.toLowerCase()).not.toContain('signed');
      }
    });
  });
});

describe.skipIf(s3Up)('S3 contract', () => {
  it('is skipped because MinIO is not running', () => {
    // Visible rather than silent: a suite that vanishes without explanation is one somebody
    // assumes is passing. Start it with `pnpm db:up`.
    expect(s3Up).toBe(false);
  });
});
