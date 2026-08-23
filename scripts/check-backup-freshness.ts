/**
 * Alerts when no recent backup exists.
 *
 * The second half of the backup-alerting blocker, and the half that is usually forgotten. A
 * failure alert only fires when the job *ran and failed*. It cannot detect the worse case: a
 * schedule that was disabled, a cron that silently stopped, a container rebuilt without its
 * crontab. That failure produces no error, no log line and no alert — just an ageing directory
 * nobody looks at, discovered on the day it is needed.
 *
 * So this asks the only question that catches it: **is the newest backup recent enough?**
 *
 * Run independently of the backup itself — a different schedule, ideally a different machine —
 * because a checker that runs from the same crontab as the thing it checks dies with it.
 *
 * Usage:
 *   pnpm ops:check-backup-freshness [--dir ./backups] [--max-age-hours 48]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { notify } from './notify';

loadEnv();

interface Args {
  dir: string;
  maxAgeHours: number;
  verifyChecksum: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: './backups', maxAgeHours: 48, verifyChecksum: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--dir' && value) args.dir = value;
    else if (flag === '--max-age-hours' && value) args.maxAgeHours = Number(value);
    else if (flag === '--skip-checksum') args.verifyChecksum = false;
  }
  return args;
}

async function raise(title: string, detail: string): Promise<never> {
  console.error(`\n  ${title}\n  ${detail}\n`);

  const results = await notify({
    severity: 'critical',
    title,
    detail,
    environment: process.env.APP_ENV ?? 'development',
    at: new Date().toISOString(),
  });

  for (const result of results) {
    console.error(`  alert ${result.delivered ? 'delivered' : 'FAILED'}: ${result.destination}`);
  }

  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.dir)) {
    await raise(
      'No backup directory',
      `"${args.dir}" does not exist. Backups have never run, or the schedule points elsewhere.`,
    );
  }

  const dumps = readdirSync(args.dir)
    .filter((name) => name.endsWith('.dump'))
    .map((name) => {
      const path = join(args.dir, name);
      return { name, path, modified: statSync(path).mtimeMs, size: statSync(path).size };
    })
    .sort((a, b) => b.modified - a.modified);

  if (dumps.length === 0) {
    await raise('No backups found', `"${args.dir}" contains no .dump files.`);
  }

  const newest = dumps[0]!;
  const ageHours = (Date.now() - newest.modified) / 3_600_000;

  if (ageHours > args.maxAgeHours) {
    await raise(
      'Backups are stale',
      `The newest backup is ${ageHours.toFixed(1)}h old (limit ${args.maxAgeHours}h). ` +
        'The schedule may have stopped running.',
    );
  }

  if (newest.size === 0) {
    await raise('Newest backup is empty', `${newest.name} is zero bytes.`);
  }

  /*
   * The checksum, because "a file exists and is recent" is not the same as "a backup exists".
   *
   * A dump truncated by a full disk has a recent timestamp and a plausible size. The only thing
   * that tells them apart is the digest recorded beside it at the moment it was written.
   */
  if (args.verifyChecksum) {
    const sidecar = `${newest.path}.sha256`;

    if (!existsSync(sidecar)) {
      await raise(
        'Newest backup has no checksum',
        `${newest.name} was written without a .sha256 beside it; its integrity cannot be checked.`,
      );
    }

    const recorded = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    const actual = createHash('sha256').update(readFileSync(newest.path)).digest('hex');

    if (recorded !== actual) {
      await raise(
        'Newest backup is CORRUPT',
        `${newest.name} does not match its recorded checksum. Do not rely on it.`,
      );
    }
  }

  const sizeMb = (newest.size / 1024 / 1024).toFixed(2);
  console.log('');
  console.log(`  Newest backup   ${newest.name}`);
  console.log(`  Age             ${ageHours.toFixed(1)}h (limit ${args.maxAgeHours}h)`);
  console.log(`  Size            ${sizeMb} MB`);
  console.log(`  Checksum        ${args.verifyChecksum ? 'verified' : 'skipped'}`);
  console.log(`  Total dumps     ${dumps.length}`);
  console.log('');
  console.log('  Backups are current.');
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
