import { createHash, randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { evidenceForReading, submitPayment } from '@/modules/payments';
import { buildMockEvidence } from '@/platform/payments';
import { S3FileStore, setFileStoreOverride } from '@/platform/storage';
import { can } from '@/platform/rbac';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { openOrder, restoreFileStore } from '../support/payment-fixtures';

/**
 * The application's evidence path, end to end, against a real S3-compatible object store.
 *
 * Everything else that touches evidence is tested against `MemoryFileStore` — a Map. That is the
 * right default: it is fast, it isolates the payment rules from the network, and there are
 * hundreds of those assertions. But it means the sequence a distributor actually depends on —
 * a bank slip leaving a browser, landing in a bucket, and coming back byte-identical through an
 * authenticated route — has only ever been exercised against an object that cannot fail.
 *
 * The storage contract suite proves the adapter in isolation. This proves the *application* on
 * top of it: upload validation, `put`, the database row that records the key and the hash, the
 * tenant-scoped read, and the three ways a read is supposed to fail closed.
 *
 * Point it at any S3-compatible endpoint. It defaults to the local MinIO; `TEST_S3_ENDPOINT` and
 * friends aim it at Supabase Storage, which is how this same suite becomes the staging evidence.
 */

const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9010';
const S3_ACCESS_KEY = process.env.TEST_S3_ACCESS_KEY_ID ?? 'distributor_minio';
const S3_SECRET_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'distributor_minio_dev';
const S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'distributor-evidence-test';
const S3_REGION = process.env.TEST_S3_REGION ?? 'us-east-1';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeStore(): S3FileStore {
  return new S3FileStore({
    bucket: S3_BUCKET,
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    forcePathStyle: true,
  });
}

/**
 * Resolved at module load, because `describe.skipIf` is evaluated during collection — before any
 * `beforeAll` has run. Deciding it in a hook produced a suite that skipped every test and then
 * reported that it had not skipped.
 *
 * The probe is the store's own `health()` rather than a provider-specific endpoint. MinIO
 * answers `/minio/health/live` and Supabase Storage does not, so a MinIO-shaped probe would
 * report Supabase as unreachable and silently skip the entire suite against exactly the
 * infrastructure it is meant to be proving.
 */
const s3Up = await (async () => {
  const client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  });

  try {
    await client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  } catch {
    // Already there, or the provider does not allow bucket creation over the S3 API — Supabase
    // creates buckets through its own control plane. `health()` is what decides.
  }

  return (await makeStore().health()).reachable;
})();

afterAll(() => restoreFileStore());

describe.skipIf(!s3Up)('payment evidence, against a real object store', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let other: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    setFileStoreOverride(makeStore());
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    other = await seedOrg('Rift Valley Traders', 'OWNER_ADMIN');
  });

  async function submitEvidence(mimeType: string, filename: string) {
    const order = await openOrder(org.organizationId, org.context);
    const amount = `${order.grandTotalMinor / 100n}.${String(order.grandTotalMinor % 100n).padStart(2, '0')}`;
    const bytes = buildMockEvidence({ amount, transactionReference: 'FT26082400001' });

    const submitted = await withTenant(org.organizationId, (tx) =>
      submitPayment(
        tx,
        org.context,
        {
          salesOrderId: order.orderId,
          amountClaimed: amount,
          method: 'BANK_TRANSFER',
          transactionReference: 'FT26082400001',
        },
        { bytes, claimedMimeType: mimeType, filename },
      ),
    );

    return { submitted, bytes, order };
  }

  it('carries bytes from the application to the bucket and back, unchanged', async () => {
    const { submitted, bytes } = await submitEvidence('application/pdf', 'receipt.pdf');

    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.evidenceFileId).not.toBeNull();

    // --- what the database recorded ------------------------------------
    const file = await owner.paymentEvidenceFile.findUniqueOrThrow({
      where: { id: submitted.value.evidenceFileId! },
    });

    expect(file.contentHash).toBe(sha256(bytes));
    expect(file.mimeType).toBe('application/pdf');
    expect(file.sizeBytes).toBe(bytes.byteLength);

    /*
     * The key is invented by the store and is tenant-prefixed. Neither half is cosmetic: the
     * prefix means a misconfigured bucket policy fails visibly rather than quietly mixing
     * tenants, and the absence of the filename means evidence cannot be found by guessing a
     * customer's name.
     */
    expect(file.storageKey).toContain(org.organizationId);
    expect(file.storageKey).not.toContain('receipt.pdf');

    // --- what comes back through the application's own read path -------
    const resolved = await withTenant(org.organizationId, (tx) =>
      evidenceForReading(tx, submitted.value.evidenceFileId!),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const { fileStore } = await import('@/platform/storage');
    const readBack = await fileStore().read(resolved.value.storageKey);

    expect(readBack).not.toBeNull();
    expect(readBack!.byteLength).toBe(bytes.byteLength);
    // Byte equality, not length equality. A store that returned a plausible-looking file of the
    // right size would pass a weaker assertion.
    expect(sha256(readBack!)).toBe(file.contentHash);
    expect(Buffer.from(readBack!).equals(Buffer.from(bytes))).toBe(true);
  });

  it('carries a photograph of a slip, which is what a phone actually uploads', async () => {
    /*
     * PNG and JPEG, with real magic bytes, because the validator decides the type from the bytes
     * and not from what the browser claimed. A salesperson in Addis photographs a bank slip on a
     * phone; the PDF path is the exception, not the rule, and it was the only one covered.
     *
     * Binary rather than text, deliberately: an object store that mangles encoding somewhere
     * would round-trip ASCII perfectly and corrupt this.
     */
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 512 }, (_, i) => i % 256),
    ]);
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 512 }, (_, i) => (i * 7) % 256), 0xff, 0xd9,
    ]);

    for (const [mimeType, filename, bytes] of [
      ['image/png', 'slip.png', png],
      ['image/jpeg', 'slip.jpg', jpeg],
    ] as const) {
      await resetDatabase();
      setFileStoreOverride(makeStore());
      org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');

      const order = await openOrder(org.organizationId, org.context);
      const amount = `${order.grandTotalMinor / 100n}.${String(order.grandTotalMinor % 100n).padStart(2, '0')}`;

      const submitted = await withTenant(org.organizationId, (tx) =>
        submitPayment(
          tx,
          org.context,
          {
            salesOrderId: order.orderId,
            amountClaimed: amount,
            method: 'BANK_TRANSFER',
            transactionReference: 'FT26082400002',
          },
          { bytes, claimedMimeType: mimeType, filename },
        ),
      );

      expect(submitted.ok, `${mimeType} should be accepted`).toBe(true);
      if (!submitted.ok) continue;

      const file = await owner.paymentEvidenceFile.findUniqueOrThrow({
        where: { id: submitted.value.evidenceFileId! },
      });
      expect(file.mimeType).toBe(mimeType);
      expect(file.contentHash).toBe(sha256(bytes));

      const { fileStore } = await import('@/platform/storage');
      const readBack = await fileStore().read(file.storageKey);
      expect(readBack).not.toBeNull();
      // Byte-for-byte, on binary content.
      expect(Buffer.from(readBack!).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('refuses bytes that are not what the browser claimed, before anything is stored', async () => {
    const order = await openOrder(org.organizationId, org.context);
    const amount = `${order.grandTotalMinor / 100n}.00`;

    const result = await withTenant(org.organizationId, (tx) =>
      submitPayment(
        tx,
        org.context,
        {
          salesOrderId: order.orderId,
          amountClaimed: amount,
          method: 'BANK_TRANSFER',
          transactionReference: 'FT26082400003',
        },
        {
          // An executable wearing a PDF's name and content type.
          bytes: new TextEncoder().encode('MZ\x90\x00 not a document at all'),
          claimedMimeType: 'application/pdf',
          filename: 'receipt.pdf',
        },
      ),
    );

    expect(result.ok).toBe(false);
    // Nothing reached the bucket and nothing reached the database.
    expect(await owner.paymentEvidenceFile.count()).toBe(0);
  });

  describe('failing closed', () => {
    it('does not resolve an evidence id belonging to another organization', async () => {
      const { submitted } = await submitEvidence('application/pdf', 'receipt.pdf');
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;

      /*
       * The same id, a different tenant. This is the whole reason reads are proxied through the
       * application rather than handed out as presigned URLs: possession of the identifier has
       * to be worth nothing, and here it is.
       */
      const foreign = await withTenant(other.organizationId, (tx) =>
        evidenceForReading(tx, submitted.value.evidenceFileId!),
      );

      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.error.code).toBe('NOT_FOUND');
    });

    it('gives the same answer for a foreign id, a malformed id and one never issued', async () => {
      const { submitted } = await submitEvidence('application/pdf', 'receipt.pdf');
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;

      const answers = await Promise.all(
        [submitted.value.evidenceFileId!, 'not-a-uuid', randomUUID()].map((id) =>
          withTenant(other.organizationId, (tx) => evidenceForReading(tx, id)),
        ),
      );

      // Indistinguishable. A response that differed would confirm which files exist.
      for (const answer of answers) {
        expect(answer.ok).toBe(false);
        if (!answer.ok) expect(answer.error.code).toBe('NOT_FOUND');
      }
    });

    it('keeps the read permission away from the roles that upload', async () => {
      /*
       * Asserted here as well as in the RBAC tests because it is the property that makes the
       * storage boundary meaningful: a salesperson can attach a customer's bank slip and can
       * never read one back, so a compromised sales session cannot be used to enumerate
       * evidence.
       */
      expect(can('SALESPERSON', 'read:payment')).toBe(false);
      expect(can('SALES_MANAGER', 'read:payment')).toBe(false);
      expect(can('WAREHOUSE', 'read:payment')).toBe(false);
      expect(can('FINANCE', 'read:payment')).toBe(true);
      expect(can('OWNER_ADMIN', 'read:payment')).toBe(true);
    });

    it('returns nothing for a key that was never issued by the store', async () => {
      const { fileStore } = await import('@/platform/storage');

      // A well-formed key for an object that does not exist, and a malformed one. Both null,
      // neither throwing — the contract the local store and S3 must agree on.
      expect(
        await fileStore().read(`organizations/${randomUUID()}/payments/${randomUUID()}`),
      ).toBeNull();
      expect(await fileStore().read('../../etc/passwd')).toBeNull();
    });
  });
});

describe.skipIf(s3Up)('payment evidence against a real object store', () => {
  it('is skipped because no S3-compatible endpoint is reachable', () => {
    // Visible rather than silent. A suite that quietly skips is a suite that stops being run.
    expect(s3Up).toBe(false);
  });
});
