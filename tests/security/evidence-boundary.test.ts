import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3FileStore } from '@/platform/storage';

/**
 * The trust boundary around payment evidence.
 *
 * Server-side S3 credentials — Supabase's included — **bypass whatever access rules the storage
 * provider offers.** A key with `s3:GetObject` on the bucket can read every object in it, for
 * every tenant, regardless of any policy configured in the provider's dashboard. That is not a
 * flaw to be worked around; it is what a server-side key is.
 *
 * So the provider's access control is not the boundary. *This application is.* Evidence is
 * protected by exactly three things, and if any of them stops being true the protection is gone:
 *
 *   1. The credentials never leave the server, so nobody else can make that S3 call.
 *   2. The bucket is private, so the object URL is not a second, unauthenticated door.
 *   3. Every read goes through a route that checks session, permission and tenant first.
 *
 * The third is proved by the evidence-lifecycle and payment suites. The first two are proved
 * here, because they are properties of the *build and the bucket* rather than of any function,
 * and nothing else would notice them changing.
 */

const SOURCE_ROOT = join(process.cwd(), 'src');

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

const SOURCE_FILES = walk(SOURCE_ROOT);

describe('credentials cannot reach the browser', () => {
  it('exposes no secret-shaped setting under NEXT_PUBLIC_', () => {
    /*
     * Next inlines every `NEXT_PUBLIC_*` value into the client bundle at build time. There is no
     * runtime guard and no warning: naming a variable `NEXT_PUBLIC_S3_SECRET_ACCESS_KEY` ships
     * it to every visitor, and the only thing standing between that and a real deployment is
     * that nobody has typed it.
     */
    const offenders: string[] = [];

    for (const file of SOURCE_FILES) {
      const contents = readFileSync(file, 'utf8');
      for (const match of contents.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
        const name = match[0];
        if (/S3|SUPABASE|SECRET|TOKEN|KEY|PASSWORD|DSN|DATABASE/.test(name)) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('reads every storage credential only from modules marked server-only', () => {
    /*
     * `import 'server-only'` makes an accidental client import a *build* failure rather than a
     * disclosure. Asserting it here means a future refactor that moves the S3 configuration into
     * a shared module cannot quietly drop the guard.
     */
    const readers = SOURCE_FILES.filter((file) => {
      const contents = readFileSync(file, 'utf8');
      return /S3_SECRET_ACCESS_KEY|S3_ACCESS_KEY_ID/.test(contents);
    });

    // If this ever becomes empty the test has stopped testing anything.
    expect(readers.length).toBeGreaterThan(0);

    for (const file of readers) {
      const contents = readFileSync(file, 'utf8');
      const guarded =
        contents.includes("import 'server-only'") ||
        // The config schema is the one place these names appear as schema keys rather than as
        // values being used; it is imported by server code and by scripts, and reading a schema
        // key exposes nothing on its own.
        file.endsWith(join('platform', 'config', 'index.ts'));

      expect(guarded, `${file} reads S3 credentials without a server-only guard`).toBe(true);
    }
  });

  it('keeps the storage module free of anything that could produce a URL', () => {
    /*
     * The rule the whole design rests on, asserted against the source rather than an instance:
     * no presigned URL is generated anywhere. A presigned URL is a bearer token for a bank slip —
     * once issued it works for anybody holding it, for as long as it lives, and it cannot be
     * revoked.
     */
    const storeSource = readFileSync(join(SOURCE_ROOT, 'platform', 'storage', 's3-store.ts'), 'utf8');

    /*
     * Comments stripped first. The file's documentation explains at length why no presigned URL
     * is generated, so a naive search for "presign" matches the very prose that promises it does
     * not happen — a test that fails precisely because the reasoning was written down.
     */
    const code = storeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toContain('getSignedUrl');
    expect(code).not.toContain('s3-request-presigner');
    expect(code).not.toMatch(/\bpresign/i);

    // And the dependency itself is absent, so it cannot be reached for without a lockfile change
    // that a reviewer would see.
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@aws-sdk/s3-request-presigner');
  });
});

/**
 * The bucket itself, asked anonymously.
 *
 * A private bucket is a configuration, and configurations drift. This is the check that would
 * notice somebody making the bucket public "temporarily" to debug something.
 */
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9010';
const S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'distributor-evidence-test';

const s3Up = await (async () => {
  const store = new S3FileStore({
    bucket: S3_BUCKET,
    region: process.env.TEST_S3_REGION ?? 'us-east-1',
    endpoint: S3_ENDPOINT,
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'distributor_minio',
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'distributor_minio_dev',
    forcePathStyle: true,
  });
  return (await store.health()).reachable;
})();

describe.skipIf(!s3Up)('the bucket is not a second door', () => {
  it('refuses an anonymous request for a stored object', async () => {
    const store = new S3FileStore({
      bucket: S3_BUCKET,
      region: process.env.TEST_S3_REGION ?? 'us-east-1',
      endpoint: S3_ENDPOINT,
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'distributor_minio',
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'distributor_minio_dev',
      forcePathStyle: true,
    });

    const stored = await store.put({
      organizationId: randomUUID(),
      bytes: new TextEncoder().encode('a synthetic bank slip that must not be publicly readable'),
      mimeType: 'application/pdf',
    });

    try {
      // No credentials, no signature — exactly what someone with the object path would send.
      const response = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}/${stored.key}`, {
        signal: AbortSignal.timeout(10_000),
      });

      expect(response.ok, 'an unauthenticated request returned the object').toBe(false);
      expect([401, 403, 404]).toContain(response.status);

      // And whatever the body is, it is not the file.
      const body = await response.text();
      expect(body).not.toContain('synthetic bank slip');
    } finally {
      await store.delete(stored.key);
    }
  });

  it('refuses to list the bucket anonymously', async () => {
    // Listing is how a leaked bucket turns from "one file" into "every file". Even with objects
    // individually protected, an anonymous listing hands over every tenant's key space.
    const response = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}`, {
      signal: AbortSignal.timeout(10_000),
    });

    expect(response.ok).toBe(false);
  });
});
