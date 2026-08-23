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

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

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
  const url = process.env.DIRECT_URL;
  if (!url) fail('DIRECT_URL must be set. A backup must be taken as the database owner.');

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

  const dumpArgs = [
    '--format=custom',
    '--compress=6',
    // Roles and tablespaces belong to the cluster, not the database. Excluding them keeps the
    // dump restorable into a fresh database whose roles were provisioned separately — which is
    // exactly what the restore drill does.
    '--no-owner',
    '--no-privileges',
    `--dbname=${dumpUrl}`,
  ];

  let dumped: Buffer;

  if (args.container) {
    /*
     * Inside the container, the connection string from `.env` is wrong.
     *
     * It names `localhost:5434` — the port Docker publishes on the *host*. From inside the
     * container there is nothing on 5434, and `localhost` is the container itself. So the URL is
     * discarded here in favour of a local connection by user and database name, which is what
     * `pg_dump` sees when it is already on the machine holding the data.
     *
     * The dump goes to stdout and is captured here, so the file lands on the host where the
     * retention policy can see it rather than inside a container that gets recreated.
     */
    const localArgs = [
      '--format=custom',
      '--compress=6',
      '--no-owner',
      '--no-privileges',
      `--username=${decodeURIComponent(parsed.username)}`,
      `--dbname=${database}`,
    ];

    const result = spawnSync(
      'docker',
      [
        'exec',
        '-e',
        `PGPASSWORD=${decodeURIComponent(parsed.password)}`,
        args.container,
        'pg_dump',
        ...localArgs,
      ],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      fail(`pg_dump failed:\n${result.stderr?.toString() ?? '(no output)'}`);
    }
    dumped = result.stdout;
  } else {
    const result = spawnSync('pg_dump', dumpArgs, {
      encoding: 'buffer',
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (result.status !== 0) {
      fail(
        `pg_dump failed:\n${result.stderr?.toString() ?? '(no output)'}\n\n` +
          'If pg_dump is not installed locally, pass --container <name> to run it inside the\n' +
          'Postgres container instead.',
      );
    }
    dumped = result.stdout;
  }

  if (dumped.length === 0) fail('pg_dump produced an empty file. Refusing to record it.');

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
