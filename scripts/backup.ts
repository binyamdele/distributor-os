/**
 * Takes a compressed, verifiable backup of the database.
 *
 * The single most important script in Phase 9. Every other gap on the operational blocker list
 * is recoverable; data loss is not, and a distributor's entire commercial history — what was
 * quoted, what was agreed, what was paid, what left the yard — lives in one PostgreSQL database.
 *
 * `pg_dump` in custom format (`-Fc`) rather than plain SQL, for three reasons that matter during
 * a restore rather than during a backup:
 *
 *   - it is compressed, so a year of audit rows does not become a gigabyte of text
 *   - `pg_restore` can read it selectively, which is what makes "restore just this table"
 *     possible at 2 a.m.
 *   - `pg_restore --list` can inspect it without restoring, so a backup can be *checked*
 *
 * A SHA-256 is written beside every dump. A truncated or silently corrupted backup is worse than
 * no backup, because it is discovered only when it is the last thing standing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { notify } from './notify';

loadEnv();

interface Args {
  out: string;
  label: string;
  container: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: './backups', label: 'manual', container: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--out' && value) args.out = value;
    else if (flag === '--label' && value) args.label = value;
    // pg_dump is often not installed on the machine running this; in development it lives in
    // the Postgres container. Named explicitly rather than guessed.
    else if (flag === '--container' && value) args.container = value;
  }
  return args;
}

/**
 * Refuses, and tells somebody.
 *
 * The whole point of the alerting blocker: a backup that fails and is recorded only in a cron log
 * nobody opens has not failed loudly enough. Every exit path from this script that means "no
 * backup was taken" goes through here.
 *
 * The alert is awaited before exiting, because a process that exits with a fetch in flight
 * cancels it — which would mean the one alert that mattered was the one that never arrived.
 */
async function fail(message: string): Promise<never> {
  console.error(`\n${message}\n`);

  const results = await notify({
    severity: 'critical',
    title: 'Database backup FAILED',
    detail: message.split('\n')[0],
    environment: process.env.APP_ENV ?? 'development',
    at: new Date().toISOString(),
  });

  for (const result of results) {
    console.error(`  alert ${result.delivered ? 'delivered' : 'FAILED'}: ${result.destination}`);
  }

  process.exit(1);
}

/**
 * The owner's connection, or an alert and an exit.
 *
 * A helper rather than an inline check because `fail` is now async, and TypeScript cannot narrow
 * a variable through an awaited `Promise<never>` — it does not know the process is gone by then.
 * Returning the string from here keeps the type honest without a cast that would hide the
 * assumption.
 */
async function requireDirectUrl(): Promise<string> {
  const url = process.env.DIRECT_URL;
  if (url) return url;

  await fail('DIRECT_URL must be set. A backup must be taken as the database owner.');
  throw new Error('unreachable');
}

/**
 * The arguments that decide what a dump contains, in one place because the two call paths below
 * must not be able to drift apart.
 */
const BASE_DUMP_ARGS = [
  '--format=custom',
  '--compress=6',
  // Roles and tablespaces belong to the cluster, not the database. Excluding them keeps the
  // dump restorable into a fresh database whose roles were provisioned separately — which is
  // exactly what the restore drill does.
  '--no-owner',
  '--no-privileges',
  /*
   * This application's data is entirely in `public`, and saying so is what makes the dump
   * portable.
   *
   * On a managed provider the database is shared with the provider's own machinery — Supabase
   * adds `auth`, `storage`, `realtime`, `graphql` and `extensions`, owned by roles like
   * `supabase_admin` that do not exist anywhere else. A whole-database dump drags all of it
   * along, and restoring that into a plain PostgreSQL 17 container fails on the missing roles
   * and extensions. The restore drill restores into exactly such a container, so an unscoped
   * dump would make the drill fail for reasons that have nothing to do with the application.
   *
   * Scoping to `public` also means the backup contains no copy of the provider's auth tables,
   * which is a smaller and better thing to be holding.
   *
   * The one consequence worth knowing: extensions are database-level objects and are not emitted
   * by a schema-scoped dump. This schema creates `pg_trgm`, and the index that used it was
   * dropped in a later migration, so nothing in a restore depends on it. If a future migration
   * adds an extension-backed index, the restore target must have that extension — which is the
   * restore drill's job to catch, and it will.
   */
  '--schema=public',
];

/** A filesystem-safe timestamp. Sorts chronologically, which is what a restore needs. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

export function run(command: string, args: string[]): { status: number; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // The owner's connection: pg_dump needs to read every table, including ones RLS would hide
  // from the application role. A backup taken as `distributor_app` would silently contain no
  // rows at all — RLS is FORCEd, so even the table owner is subject to it.
  const url = await requireDirectUrl();

  /*
   * Prisma-specific query parameters are stripped before libpq sees the string.
   *
   * `?schema=public` is a Prisma convention; libpq rejects it outright with "invalid URI query
   * parameter". Passing the connection string through unchanged fails at the very first backup —
   * which is precisely the moment nobody wants to be debugging a URL.
   */
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '');

  const LIBPQ_PARAMS = new Set(['sslmode', 'connect_timeout', 'application_name', 'options']);
  for (const key of [...parsed.searchParams.keys()]) {
    if (!LIBPQ_PARAMS.has(key)) parsed.searchParams.delete(key);
  }
  const dumpUrl = parsed.toString();

  if (!existsSync(args.out)) mkdirSync(args.out, { recursive: true });

  const filename = `${database}-${args.label}-${stamp()}.dump`;
  const target = join(args.out, filename);

  console.log(`\nBacking up "${database}"…`);

  const dumpArgs = [...BASE_DUMP_ARGS, `--dbname=${dumpUrl}`];

  let dumped: Buffer;

  if (args.container) {
    /*
     * The container runs `pg_dump`. *Which database it dumps depends on where the database is.*
     *
     * The original version always discarded the connection string and dumped a local database by
     * user and name. That is right for development — the URL says `localhost:5434`, which is the
     * port Docker publishes on the *host*, and from inside the container there is nothing there.
     *
     * It is wrong for a managed database, and quietly so. Point `DIRECT_URL` at Supabase, pass
     * `--container distributor-os-postgres` because the host has no `pg_dump`, and the old code
     * discarded the host entirely and dumped whatever the local container held. Usually that
     * fails on an unknown role and merely wastes an afternoon. When the local container happens
     * to have a role and database of the same names — which a stock `postgres` image and a
     * provider username of `postgres` give you by default — it *succeeds*, and writes the wrong
     * database out under a filename and checksum implying it is the staging backup. That is
     * worse than no backup: it restores cleanly, and the mistake surfaces only when somebody
     * looks for a row that was never in it.
     *
     * So the host decides. Loopback means the container is the database and a local connection
     * is correct; anything else means the container is only being borrowed as a client, and the
     * full connection string is passed through — which also carries `sslmode=require`, without
     * which a managed provider refuses the connection outright.
     */
    const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    const databaseIsInTheContainer = LOOPBACK.has(parsed.hostname);

    const inContainerArgs = databaseIsInTheContainer
      ? [...BASE_DUMP_ARGS, `--username=${decodeURIComponent(parsed.username)}`, `--dbname=${database}`]
      : [...BASE_DUMP_ARGS, `--dbname=${dumpUrl}`];

    console.log(
      databaseIsInTheContainer
        ? `  Dumping the database inside "${args.container}".`
        : `  Using "${args.container}" as a pg_dump client for ${parsed.hostname}.`,
    );

    const result = spawnSync(
      'docker',
      [
        'exec',
        '-e',
        `PGPASSWORD=${decodeURIComponent(parsed.password)}`,
        args.container,
        'pg_dump',
        ...inContainerArgs,
      ],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      await fail(`pg_dump failed:\n${result.stderr?.toString() ?? '(no output)'}`);
    }
    dumped = result.stdout;
  } else {
    const result = spawnSync('pg_dump', dumpArgs, {
      encoding: 'buffer',
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (result.status !== 0) {
      await fail(
        `pg_dump failed:\n${result.stderr?.toString() ?? '(no output)'}\n\n` +
          'If pg_dump is not installed locally, pass --container <name> to run it inside the\n' +
          'Postgres container instead.',
      );
    }
    dumped = result.stdout;
  }

  if (dumped.length === 0) await fail('pg_dump produced an empty file. Refusing to record it.');

  writeFileSync(target, dumped);

  // The checksum is the difference between a backup and a file. A truncated dump is worse than
  // no dump, because it is discovered only when it is the last thing standing.
  const checksum = createHash('sha256').update(dumped).digest('hex');
  writeFileSync(`${target}.sha256`, `${checksum}  ${filename}\n`);

  const sizeMb = (statSync(target).size / 1024 / 1024).toFixed(2);

  console.log('');
  console.log(`  File      ${target}`);
  console.log(`  Size      ${sizeMb} MB`);
  console.log(`  SHA-256   ${checksum}`);
  console.log('');
  console.log('  Verify later with:');
  console.log(`    sha256sum -c ${filename}.sha256`);
  console.log('');
  console.log('  A backup is not proven until it has been restored. See');
  console.log('  docs/backup-and-restore-runbook.md and pnpm ops:restore-drill.');
  console.log('');
}

/** Reads back a recorded checksum, for the restore drill and for verification. */
export function recordedChecksum(dumpPath: string): string | null {
  const sidecar = `${dumpPath}.sha256`;
  if (!existsSync(sidecar)) return null;
  return readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? null;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
