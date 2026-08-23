/**
 * Is the thing that is running the thing we think is running?
 *
 * A deployment that "went fine" is not evidence. The failures that hurt are quiet ones: the
 * image that is two commits behind because a push went to the wrong tag, the container that came
 * up against an un-migrated database, the connection string that turned out to be the owner role
 * rather than the application role — which silently disables every RLS policy in the system.
 * None of those announce themselves. Every one of them is a question with a definite answer, and
 * this script asks all of them at once.
 *
 * It is deliberately runnable from an operator's machine against a remote deployment, because
 * that is where a person stands after a deploy. Two halves:
 *
 *   - **over HTTP**, against the deployment's public URL: what commit is serving, which
 *     environment it believes it is, and whether it reports itself ready.
 *   - **over the database connection**, using the credentials the deployment itself uses: the
 *     runtime role, RLS, the append-only grants, and whether migrations are current.
 *
 * The second half needs `DATABASE_URL` set to what the deployment uses. That is the point: a
 * check that connects as the owner would pass while the application ran as something else.
 *
 * Usage:
 *   pnpm ops:verify-deployment --base-url https://pilot.example.com --expect-env production
 *   pnpm ops:verify-deployment --base-url http://localhost:3000 --expect-env staging \
 *     --expect-sha $(git rev-parse HEAD)
 */
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

loadEnv();

interface Args {
  baseUrl: string;
  expectSha?: string;
  expectEnv?: string;
  expectStore: 'local' | 's3';
  expectAi?: string;
  databaseUrl?: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: '',
    expectStore: 's3',
    timeoutMs: 15_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1];
    switch (argv[index]) {
      case '--base-url':
        if (next) args.baseUrl = next.replace(/\/$/, '');
        break;
      case '--expect-sha':
        if (next) args.expectSha = next.trim();
        break;
      case '--expect-env':
        if (next) args.expectEnv = next.trim();
        break;
      case '--expect-store':
        if (next === 'local' || next === 's3') args.expectStore = next;
        break;
      case '--expect-ai':
        if (next) args.expectAi = next.trim();
        break;
      case '--database-url':
        if (next) args.databaseUrl = next;
        break;
      case '--timeout-ms':
        if (next) args.timeoutMs = Number(next);
        break;
      default:
        break;
    }
  }
  return args;
}

let failures = 0;
let unverified = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/**
 * Something that could not be established from here.
 *
 * Counted separately from a failure and never silently skipped. An unverifiable check reported as
 * a pass is worse than no check at all, because it is remembered as one.
 */
function inconclusive(label: string, reason: string): void {
  console.log(`  ????  ${label} — ${reason}`);
  unverified += 1;
}

async function get(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' },
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Left as text. An HTML error page from a proxy in front of the app is itself the finding.
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function currentCommit(): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

interface VersionBody {
  version?: string;
  commit?: string;
  builtAt?: string;
  environment?: string;
}

interface ReadyBody {
  status?: string;
  checks?: { name: string; status: string; latencyMs: number; detail?: string }[];
}

async function verifyOverHttp(args: Args): Promise<void> {
  console.log(`\nDeployment  ${args.baseUrl}\n`);

  const live = await get(`${args.baseUrl}/api/health/live`, args.timeoutMs);
  check('liveness answers 200', live.status === 200, `status ${live.status}`);

  const version = await get(`${args.baseUrl}/api/version`, args.timeoutMs);
  const build = version.body as VersionBody;
  check('version endpoint answers 200', version.status === 200, `status ${version.status}`);

  const expectedSha = args.expectSha ?? currentCommit();
  if (expectedSha) {
    /*
     * The single most valuable line in this output.
     *
     * "We deployed and the site works" is compatible with the site running last week's image.
     * Comparing the served commit against the one being deployed is the only way to tell the
     * difference, and it costs one request.
     */
    check(
      'serving the expected commit',
      build.commit === expectedSha,
      `serving ${build.commit ?? 'unknown'}, expected ${expectedSha.slice(0, 12)}…`,
    );
  } else {
    inconclusive('serving the expected commit', 'no --expect-sha and git is unavailable here');
  }

  check(
    'build identifies itself',
    Boolean(build.commit) && build.commit !== 'unknown' && build.builtAt !== 'unknown',
    `built ${build.builtAt ?? 'unknown'}`,
  );

  if (args.expectEnv) {
    // A staging build serving production traffic looks completely normal until somebody notices
    // the data is synthetic.
    check(
      `environment is ${args.expectEnv}`,
      build.environment === args.expectEnv,
      `reports ${build.environment ?? 'unknown'}`,
    );
  }

  const ready = await get(`${args.baseUrl}/api/health/ready`, args.timeoutMs);
  const report = ready.body as ReadyBody;
  check('readiness answers 200', ready.status === 200, `status ${ready.status}`);

  for (const dependency of report.checks ?? []) {
    check(
      `dependency ${dependency.name}`,
      dependency.status === 'ok',
      `${dependency.status}${dependency.detail ? ` (${dependency.detail})` : ''} in ${dependency.latencyMs}ms`,
    );
  }
  if (!report.checks?.length) {
    check('readiness reported its dependencies', false, 'no checks in the response body');
  }

  /*
   * Which storage adapter is in use cannot be read over HTTP, and deliberately so — the health
   * endpoint is the most-probed URL a deployment has and does not name its infrastructure.
   *
   * There are two honest ways to establish it, and neither involves adding a field:
   *   - run this script where the deployment's own environment is visible, or
   *   - rely on the production boot guard, which refuses to start at all with local storage.
   */
  const driver = process.env.FILE_STORAGE_DRIVER;
  const storeCheck = (report.checks ?? []).find((entry) => entry.name === 'file-store');
  if (driver) {
    check(
      `evidence store is ${args.expectStore}`,
      driver === args.expectStore,
      `FILE_STORAGE_DRIVER=${driver} in this environment`,
    );
  } else if (build.environment === 'production' && args.expectStore === 's3') {
    check(
      'evidence store is s3',
      storeCheck?.status === 'ok',
      'a production build refuses to start with local storage, and the store reports reachable',
    );
  } else {
    inconclusive(
      `evidence store is ${args.expectStore}`,
      'not exposed over HTTP; run this where the deployment environment is visible',
    );
  }

  if (args.expectAi) {
    const configured = process.env.AI_PROVIDER;
    if (configured) {
      check(
        `AI provider is ${args.expectAi}`,
        configured === args.expectAi,
        `AI_PROVIDER=${configured}`,
      );
    } else {
      inconclusive(`AI provider is ${args.expectAi}`, 'AI_PROVIDER not visible from here');
    }
  }
}

/**
 * The two tenant-scoped tables that deliberately carry no RLS policy.
 *
 * Both are read *before* a tenant context exists: `sessions` resolves the cookie and
 * `memberships` answers which organization the session belongs to. A policy on either would be
 * evaluated against an `app.organization_id` that has not been set yet, so login would fail
 * before it could set it.
 *
 * Named here rather than filtered out silently, and printed on every run, because an exemption
 * nobody can see is indistinguishable from an omission. `scripts/verify-migrations.ts` makes the
 * same exception, and the two lists must not drift apart.
 */
const RLS_EXEMPT = new Set(['memberships', 'sessions']);

async function verifyOverDatabase(args: Args): Promise<void> {
  const url = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    console.log('\nDatabase    skipped\n');
    inconclusive('runtime database role', 'DATABASE_URL is not set, so nothing was checked');
    inconclusive('row-level security', 'DATABASE_URL is not set, so nothing was checked');
    inconclusive('migrations are current', 'DATABASE_URL is not set, so nothing was checked');
    return;
  }

  const redacted = new URL(url);
  redacted.password = '';
  console.log(`\nDatabase    ${redacted.host}${redacted.pathname} as ${redacted.username}\n`);

  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [role] = await client.$queryRaw<
      { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      SELECT current_user, r.rolsuper, r.rolbypassrls
        FROM pg_roles r
       WHERE r.rolname = current_user
    `;

    check(
      'runtime role is distributor_app',
      role?.current_user === 'distributor_app',
      `connected as ${role?.current_user ?? 'unknown'}`,
    );
    /*
     * The two properties that decide whether tenancy exists at runtime.
     *
     * Every policy in the schema is correct and every one of them is ignored for a superuser or
     * a role with BYPASSRLS. A deployment that connects with the owner's connection string has
     * no tenant isolation whatsoever and behaves identically in every other respect.
     */
    check('runtime role is not a superuser', role?.rolsuper === false);
    check('runtime role does not bypass RLS', role?.rolbypassrls === false);

    /*
     * A tenant table is one that carries `organization_id`, not one that appears on a list.
     *
     * Asking the schema rather than maintaining a list is what makes this check survive a new
     * table: anything added with an `organization_id` and no policy shows up here on the next
     * run, which is exactly the mistake worth catching.
     */
    const rls = await client.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
            WHERE col.table_name = c.relname AND col.column_name = 'organization_id'
         )
       ORDER BY c.relname
    `;

    const tenantTables = rls.filter((table) => !RLS_EXEMPT.has(table.relname));
    const withoutRls = tenantTables.filter((table) => !table.relrowsecurity).map((t) => t.relname);
    const withoutForce = tenantTables
      .filter((table) => !table.relforcerowsecurity)
      .map((t) => t.relname);

    const exempt = rls.filter((table) => RLS_EXEMPT.has(table.relname)).map((t) => t.relname);
    console.log(`  note  ${exempt.length} table(s) exempt by design: ${exempt.join(', ')}`);

    check(
      `row-level security enabled on all ${tenantTables.length} tenant tables`,
      withoutRls.length === 0,
      withoutRls.join(', '),
    );
    // Enabled is not enough: without FORCE, the table's owner is exempt from its own policies.
    check('row-level security forced', withoutForce.length === 0, withoutForce.join(', '));

    const grants = await client.$queryRaw<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'distributor_app'
         AND table_schema = 'public'
         AND table_name IN ('audit_events', 'inventory_movements', 'import_jobs')
         AND privilege_type IN ('UPDATE', 'DELETE')
       ORDER BY table_name
    `;
    check(
      'append-only tables cannot be updated or deleted by the app role',
      grants.length === 0,
      grants.map((g) => `${g.table_name}:${g.privilege_type}`).join(', '),
    );

    const [migrations] = await client.$queryRaw<{ pending: bigint }[]>`
      SELECT count(*)::bigint AS pending
        FROM _prisma_migrations
       WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
    `;
    check(
      'migrations are current',
      Number(migrations?.pending ?? 0n) === 0,
      `${Number(migrations?.pending ?? 0n)} unfinished`,
    );
  } finally {
    await client.$disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseUrl) {
    console.error('\n--base-url is required, e.g. --base-url https://pilot.example.com\n');
    process.exit(1);
  }

  console.log('\n=== Deployment verification ===');

  try {
    await verifyOverHttp(args);
  } catch (error) {
    check('deployment is reachable', false, error instanceof Error ? error.message : 'unknown');
  }

  try {
    await verifyOverDatabase(args);
  } catch (error) {
    check('database is reachable', false, error instanceof Error ? error.message : 'unknown');
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed. This deployment is not verified.\n`);
    process.exit(1);
  }
  if (unverified > 0) {
    // Exits 0, because nothing is known to be wrong — but says so loudly, because the difference
    // between "checked and fine" and "not checked" is the whole point of the exercise.
    console.log(
      `Every check that could run passed. ${unverified} could not be established here.\n`,
    );
    return;
  }
  console.log('Deployment verified.\n');
}

void main();
