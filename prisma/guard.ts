/**
 * The guard every destructive or demo script must pass through.
 *
 * Phase 9's assessment put "the demo seed can be run against production" at the top of the
 * blocker list, and it deserved to be there. `prisma/seed.ts` fabricates customers and prices;
 * `prisma/seed-fulfillment.ts` deliberately disables the consumed-reservation immutability
 * trigger so a demo can be reset. Both are correct for a demo and catastrophic as operations a
 * production deployment can reach.
 *
 * Deliberately a standalone module with no `server-only` import and no dependency on the
 * application's config layer: these run as CLI scripts under `tsx`, where `server-only` throws.
 * The rule it enforces is the same one `destructiveOperationsAllowed` states, and a unit test
 * asserts the two agree so they cannot drift apart.
 *
 * The check is on `APP_ENV`, not `NODE_ENV`, because staging runs a production *build* against
 * synthetic data and must be able to reset itself.
 */

export type Operation = 'demo seed' | 'destructive reset' | 'volume seed';

const PERMITTED = new Set(['development', 'test']);

export interface GuardVerdict {
  readonly allowed: boolean;
  readonly appEnv: string;
  readonly reason: string;
}

export function assessGuard(
  operation: Operation,
  env: NodeJS.ProcessEnv = process.env,
): GuardVerdict {
  const appEnv = env.APP_ENV ?? 'development';

  if (PERMITTED.has(appEnv)) {
    return { allowed: true, appEnv, reason: '' };
  }

  return {
    allowed: false,
    appEnv,
    reason:
      `Refusing to run the ${operation} with APP_ENV="${appEnv}".\n\n` +
      'This script writes fabricated data and, in the fulfilment seed, temporarily disables the\n' +
      'trigger that makes a consumed stock reservation immutable. Neither belongs anywhere near\n' +
      "a real distributor's records.\n\n" +
      'If this is genuinely a development machine, set APP_ENV=development.',
  };
}

/**
 * Refuses and exits, rather than throwing.
 *
 * A stack trace at the end of an accidental `pnpm db:seed` against production would bury the one
 * sentence that matters under twenty lines of Node internals.
 */
export function guardDestructive(operation: Operation, env: NodeJS.ProcessEnv = process.env): void {
  const verdict = assessGuard(operation, env);
  if (verdict.allowed) return;

  console.error(`\n${verdict.reason}\n`);
  process.exit(1);
}

/**
 * A second, independent check: does the target database look like production?
 *
 * `APP_ENV` is a promise the operator makes about their shell. This looks at where the
 * connection string actually points, so a developer who exported a production URL into a
 * terminal that still says `development` is stopped by something other than their own
 * bookkeeping. Two weak checks that fail independently beat one strong check that can be
 * bypassed by a single mistake.
 */
export function looksLikeProductionDatabase(url: string | undefined): boolean {
  if (!url) return false;

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  const local =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres';
  return !local;
}

export function guardDatabaseTarget(
  operation: Operation,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const url = env.DIRECT_URL ?? env.DATABASE_URL;
  if (!looksLikeProductionDatabase(url)) return;

  let host = 'a remote host';
  try {
    host = new URL(url!).hostname;
  } catch {
    /* the message degrades, the refusal does not */
  }

  console.error(
    `\nRefusing to run the ${operation}: the database is at "${host}", which is not local.\n\n` +
      'Demo and destructive scripts are for a local development database only. If you genuinely\n' +
      'need to load synthetic data into a remote staging database, do it deliberately with a\n' +
      'connection string on the command line rather than through this script.\n',
  );
  process.exit(1);
}
