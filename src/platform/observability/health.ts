import 'server-only';
import { prisma } from '@/platform/db/client';
import { config } from '@/platform/config';
import { fileStore } from '@/platform/storage';

/**
 * Liveness and readiness, deliberately different questions.
 *
 * **Liveness** asks whether this process is alive. It must not touch the database, because if it
 * did, a database blip would make an orchestrator kill and restart every healthy application
 * container — turning a recoverable dependency outage into a restart storm at the worst possible
 * moment.
 *
 * **Readiness** asks whether this process can serve business traffic. It checks the dependencies
 * that a request would actually need, so a container with an unreachable database is taken out
 * of rotation rather than serving errors.
 *
 * Neither exposes a secret, a stack trace, a connection string or a hostname. A health endpoint
 * is typically the most-probed URL a deployment has, and often reachable before authentication;
 * "it returns the DB host so we can debug faster" is how a reconnaissance target gets created.
 */

export interface DependencyCheck {
  readonly name: string;
  readonly status: 'ok' | 'degraded' | 'failed';
  readonly latencyMs: number;
  /** Safe to show. Never an exception message, a path or an address. */
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: readonly DependencyCheck[];
}

async function timed(
  name: string,
  check: () => Promise<{ status: DependencyCheck['status']; detail?: string }>,
): Promise<DependencyCheck> {
  const startedAt = Date.now();
  try {
    const result = await check();
    return { name, latencyMs: Date.now() - startedAt, ...result };
  } catch {
    // The reason is deliberately not propagated. It is logged by the caller; the response says
    // only that the check failed.
    return { name, status: 'failed', latencyMs: Date.now() - startedAt };
  }
}

const MIGRATION_TIMEOUT_MS = 5_000;

/**
 * Every dependency a business request would touch.
 *
 * Run concurrently, so a slow one does not serialise behind the others and turn a readiness probe
 * into a timeout of its own.
 */
export async function checkReadiness(): Promise<ReadinessReport> {
  const settings = config();

  const checks = await Promise.all([
    timed('database', async () => {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' as const };
    }),

    timed('migrations', async () => {
      /*
       * A container running old code against a newer schema, or newer code against an
       * un-migrated database, is the classic half-deployed state — and it usually presents as
       * scattered, confusing errors rather than as an outage. Asking whether any migration is
       * unapplied or failed turns that into a readiness failure the deploy can act on.
       */
      const rows = await Promise.race([
        prisma.$queryRaw<{ pending: bigint }[]>`
          SELECT count(*)::bigint AS pending
            FROM _prisma_migrations
           WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
        `,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), MIGRATION_TIMEOUT_MS),
        ),
      ]);

      const pending = Number(rows[0]?.pending ?? 0n);
      return pending === 0
        ? { status: 'ok' as const }
        : { status: 'failed' as const, detail: `${pending} migration(s) not finished` };
    }),

    timed('file-store', async () => {
      /*
       * The store's own health probe, not a lookup for a key that does not exist.
       *
       * The earlier version asked `getMetadata` for a fabricated key and treated any thrown
       * error as unhealthy. On local disk that was nearly right. Against S3 it is wrong in both
       * directions: a missing object returns null rather than throwing, so a bucket with bad
       * credentials would still have looked fine, while a provider that answers 403 for a
       * missing key would have looked broken when it was not. `health()` asks the question
       * directly — can this store be reached and used — and answers with a category rather than
       * a message.
       */
      const health = await fileStore().health();
      if (health.reachable) return { status: 'ok' as const };
      return { status: 'degraded' as const, detail: health.detail ?? 'unreachable' };
    }),
  ]);

  /*
   * A degraded evidence store is reported and served through — for every environment except a
   * production one that requires it.
   *
   * Phase 9 reasoned that quotations, orders, warehouse and delivery all keep working when a
   * bucket is unreachable, so taking the whole application out of rotation would be a larger
   * outage than the real one. That still holds. What it missed is that a production deployment
   * configured for S3 has *declared* evidence storage to be a required dependency: payments
   * cannot be submitted or reviewed without it, which is half the product, and reporting READY
   * in that state would tell a load balancer to keep sending traffic that cannot be served.
   *
   * So the rule is: degraded is tolerable unless the deployment says the store is required.
   */
  const storeRequired = settings.APP_ENV === 'production' && settings.FILE_STORAGE_DRIVER === 's3';

  const blocked = checks.some(
    (check) =>
      check.status === 'failed' ||
      (storeRequired && check.name === 'file-store' && check.status === 'degraded'),
  );

  return { ready: !blocked, checks };
}

export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
  readonly builtAt: string;
  readonly environment: string;
}

/**
 * What is deployed.
 *
 * "Which version are you running?" currently has no answer, and during a support call that is
 * the first question. The commit SHA is safe to expose: the repository is not public, and
 * knowing a hash grants nothing. The environment name is included because a bug report from
 * staging and one from production need to be told apart immediately.
 */
export function buildInfo(): BuildInfo {
  const settings = config();
  return {
    version: settings.APP_VERSION,
    commit: settings.BUILD_SHA,
    builtAt: settings.BUILD_TIME,
    environment: settings.APP_ENV,
  };
}
