import 'server-only';
import { PrismaClient } from '@prisma/client';

/**
 * The raw, unscoped Prisma client.
 *
 * Nothing outside `src/platform/db` may import this, and an ESLint rule enforces that. It is
 * unscoped by construction: a query issued through it sees every organization's rows. Business
 * code goes through `withTenant()` instead, which injects the organization filter and sets the
 * RLS session variable.
 *
 * The only legitimate unscoped callers are authentication (finding a user by email, before any
 * organization is known) and the seed script.
 */

/**
 * Pool size and timeout, applied to the connection string.
 *
 * Prisma takes both as query parameters rather than as client options, which is easy to miss —
 * a `DATABASE_POOL_SIZE` in the environment that nothing reads is worse than no setting at all,
 * because it looks configured.
 *
 * Small by default, on purpose. Managed Postgres plans cap total connections, and a container
 * that opens more than its share starves everything else on the same database — including the
 * migration job during a deploy, and the admin session somebody opens to find out why. This
 * application holds transactions briefly and a pilot serves a handful of concurrent users, so
 * ten is generous.
 *
 * The timeout matters as much as the size: without it, a request that cannot get a connection
 * waits forever and the user watches a spinner. With it, the request fails, the error is
 * recorded against a correlation id, and the queue drains.
 */
function connectionUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;

  try {
    const url = new URL(raw);

    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', process.env.DATABASE_POOL_SIZE ?? '10');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', process.env.DATABASE_POOL_TIMEOUT_SECONDS ?? '20');
    }

    return url.toString();
  } catch {
    // A malformed URL is the config layer's problem to report, not this module's to swallow.
    return raw;
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaShutdownRegistered?: boolean;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.APP_ENV === 'development' ? ['warn', 'error'] : ['error'],
    datasources: { db: { url: connectionUrl() } },
  });

// Next.js hot-reloads modules in development; without this, every reload opens a new pool.
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * Graceful shutdown.
 *
 * On SIGTERM a platform gives the container a window — usually ten to thirty seconds — before
 * SIGKILL. What happens in that window decides whether a deploy is invisible or whether somebody
 * loses the order they were confirming.
 *
 * Node's default SIGTERM handling is to exit immediately, which severs open transactions
 * mid-flight. They roll back, so nothing is corrupted — this codebase is transactional
 * throughout — but the user sees a failure for an operation that would have succeeded a second
 * later, and during a rolling deploy that is every user with a request in progress.
 *
 * So the handler waits briefly for in-flight work to finish, then closes the pool so PostgreSQL
 * reclaims the connections immediately rather than waiting for TCP timeouts. It does not try to
 * be clever: there is no request draining, because Next.js owns the server socket, and pretending
 * otherwise would be a claim this module cannot honour.
 *
 * Registered once, guarded by a global, because Next.js may evaluate this module more than once
 * and Node warns about listener accumulation for good reason.
 */
if (!globalForPrisma.prismaShutdownRegistered && typeof process !== 'undefined') {
  globalForPrisma.prismaShutdownRegistered = true;

  const GRACE_MS = 5_000;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    // A short pause so requests already inside a transaction can commit. Long enough for this
    // application's operations, which are milliseconds; short enough to stay well inside any
    // platform's kill window.
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS));

    try {
      await prisma.$disconnect();
    } catch {
      // Shutting down anyway. A failure to disconnect cleanly is not worth crashing over, and
      // the connections are reclaimed by the database when the process goes.
    }

    process.exit(signal === 'SIGTERM' ? 0 : 130);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

export type { PrismaClient };
