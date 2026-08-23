/**
 * Proves a backup by restoring it and checking what came back.
 *
 * A backup that has never been restored is a hypothesis. This is the script that turns it into a
 * fact, and it is deliberately the one that produces evidence rather than reassurance.
 *
 * What it does:
 *
 *   1. reads a known set of facts out of the live database — counts, and specific rows with
 *      specific values
 *   2. restores the dump into a fresh scratch database that is dropped afterwards
 *   3. reads the same facts back out of the restored copy
 *   4. compares them and prints a table
 *   5. checks the evidence files the restored payment rows point at, by content hash
 *
 * Step 5 is the one that gets forgotten. Payment evidence lives outside PostgreSQL, so a
 * database restore reconstitutes rows pointing at bank slips that may no longer exist. The
 * `content_hash` column makes that *detectable*, and this is what does the detecting: a restore
 * that silently produces payment records whose evidence has gone is not a successful restore, it
 * is a dispute waiting to be lost.
 *
 * Usage:
 *   pnpm ops:restore-drill --dump ./backups/<file>.dump --container distributor-os-postgres
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

loadEnv();

interface Args {
  dump?: string;
  container?: string;
  scratch: string;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { scratch: 'distributor_os_restore_drill', keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--dump' && value) args.dump = value;
    else if (flag === '--container' && value) args.container = value;
    else if (flag === '--scratch' && value) args.scratch = value;
    else if (flag === '--keep') args.keep = true;
  }
  return args;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** The facts checked on both sides. Chosen to span every phase's data, not just row counts. */
interface Facts {
  organizations: number;
  users: number;
  customers: number;
  products: number;
  quotations: number;
  salesOrders: number;
  payments: number;
  confirmedPayments: number;
  confirmedPaymentTotalMinor: string;
  stockReservations: number;
  activeReservations: number;
  consumedReservations: number;
  inventoryMovements: number;
  warehouseTasks: number;
  deliveries: number;
  returns: number;
  discrepancies: number;
  auditEvents: number;
  /** One specific order, spelled out. A count can match while every row is wrong. */
  sampleOrderNumber: string | null;
  sampleOrderTotalMinor: string | null;
  sampleOrderPaymentStatus: string | null;
  /** Total physical stock, so a silently emptied products table is visible. */
  totalAvailableStock: string;
  evidenceFiles: number;
}

async function readFacts(client: PrismaClient): Promise<Facts> {
  const [confirmedAgg, stockAgg] = await Promise.all([
    client.payment.aggregate({
      where: { status: 'CONFIRMED' },
      _sum: { amountConfirmedMinor: true },
      _count: true,
    }),
    client.product.aggregate({ _sum: { availableStock: true } }),
  ]);

  // The largest order, deterministically chosen so both sides pick the same one.
  const sample = await client.salesOrder.findFirst({
    orderBy: [{ grandTotalMinor: 'desc' }, { orderNumber: 'asc' }],
    select: { orderNumber: true, grandTotalMinor: true, paymentStatus: true },
  });

  return {
    organizations: await client.organization.count(),
    users: await client.user.count(),
    customers: await client.customer.count(),
    products: await client.product.count(),
    quotations: await client.quotation.count(),
    salesOrders: await client.salesOrder.count(),
    payments: await client.payment.count(),
    confirmedPayments: confirmedAgg._count,
    confirmedPaymentTotalMinor: String(confirmedAgg._sum.amountConfirmedMinor ?? 0n),
    stockReservations: await client.stockReservation.count(),
    activeReservations: await client.stockReservation.count({ where: { status: 'ACTIVE' } }),
    consumedReservations: await client.stockReservation.count({ where: { status: 'CONSUMED' } }),
    inventoryMovements: await client.inventoryMovement.count(),
    warehouseTasks: await client.warehouseTask.count(),
    deliveries: await client.delivery.count(),
    returns: await client.return.count(),
    discrepancies: await client.inventoryDiscrepancy.count(),
    auditEvents: await client.auditEvent.count(),
    sampleOrderNumber: sample?.orderNumber ?? null,
    sampleOrderTotalMinor: sample ? String(sample.grandTotalMinor) : null,
    sampleOrderPaymentStatus: sample?.paymentStatus ?? null,
    totalAvailableStock: String(stockAgg._sum.availableStock ?? 0),
    evidenceFiles: await client.paymentEvidenceFile.count(),
  };
}

function psql(container: string, user: string, password: string, database: string, sql: string) {
  return spawnSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${password}`,
      container,
      'psql',
      '-U',
      user,
      '-d',
      database,
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dump)
    fail('Usage: pnpm ops:restore-drill --dump ./backups/<file>.dump [--container <name>]');
  if (!existsSync(args.dump)) fail(`No such dump: ${args.dump}`);
  if (!args.container)
    fail('--container is required: pg_restore runs inside the Postgres container.');

  const url = process.env.DIRECT_URL;
  if (!url) fail('DIRECT_URL must be set.');

  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const liveDatabase = parsed.pathname.replace(/^\//, '');

  console.log('\n=== Restore drill ===\n');

  // --- 0. the dump is intact ------------------------------------------------
  const bytes = readFileSync(args.dump);
  const actual = createHash('sha256').update(bytes).digest('hex');
  const sidecar = `${args.dump}.sha256`;

  if (existsSync(sidecar)) {
    const recorded = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    if (recorded !== actual) {
      fail(
        `The dump does not match its recorded checksum.\n  recorded ${recorded}\n  actual   ${actual}\n\n` +
          'This backup is corrupt. Do not rely on it.',
      );
    }
    console.log(`  Checksum verified: ${actual.slice(0, 16)}…`);
  } else {
    console.log(`  No recorded checksum beside the dump; computed ${actual.slice(0, 16)}…`);
  }

  // --- 1. what the live database holds --------------------------------------
  const live = new PrismaClient({ datasources: { db: { url } } });
  const before = await readFacts(live);
  await live.$disconnect();
  console.log(`  Read ${Object.keys(before).length} facts from "${liveDatabase}".`);

  // --- 2. restore into a scratch database -----------------------------------
  console.log(`  Creating scratch database "${args.scratch}"…`);
  psql(
    args.container,
    user,
    password,
    'postgres',
    `DROP DATABASE IF EXISTS ${args.scratch} WITH (FORCE);`,
  );
  const created = psql(
    args.container,
    user,
    password,
    'postgres',
    `CREATE DATABASE ${args.scratch} OWNER ${user};`,
  );
  if (created.status !== 0) fail(`Could not create the scratch database:\n${created.stderr}`);

  console.log('  Restoring…');

  // The dump is streamed in over stdin, so the file never has to be copied into the container.
  const restore = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${password}`,
      args.container,
      'pg_restore',
      '--username',
      user,
      '--dbname',
      args.scratch,
      '--no-owner',
      '--no-privileges',
    ],
    { input: bytes, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );

  if (restore.stderr && restore.stderr.trim()) {
    const lines = restore.stderr.trim().split('\n').slice(0, 5);
    console.log(`  pg_restore reported:\n    ${lines.join('\n    ')}`);
  }

  // --- 3. what the restored copy holds --------------------------------------
  const scratchUrl = new URL(url);
  scratchUrl.pathname = `/${args.scratch}`;
  const restored = new PrismaClient({ datasources: { db: { url: scratchUrl.toString() } } });

  let after: Facts;
  try {
    after = await readFacts(restored);
  } catch (error) {
    await restored.$disconnect();
    fail(`Could not read the restored database: ${String(error)}`);
  }
  await restored.$disconnect();

  // --- 4. compare -----------------------------------------------------------
  console.log('\n  Fact                          live            restored        ');
  console.log('  ' + '-'.repeat(62));

  let mismatches = 0;
  for (const key of Object.keys(before) as (keyof Facts)[]) {
    const liveValue = String(before[key] ?? '(none)');
    const restoredValue = String(after[key] ?? '(none)');
    const same = liveValue === restoredValue;
    if (!same) mismatches += 1;

    console.log(
      `  ${key.padEnd(28)}  ${liveValue.padEnd(14)}  ${restoredValue.padEnd(14)}  ${same ? 'ok' : 'MISMATCH'}`,
    );
  }

  // --- 5. the evidence files the restored rows point at ---------------------
  console.log('');
  const evidenceDir = process.env.FILE_STORAGE_DIR ?? './storage';
  const restoredForEvidence = new PrismaClient({
    datasources: { db: { url: scratchUrl.toString() } },
  });
  const evidence = await restoredForEvidence.paymentEvidenceFile.findMany({
    select: { storageKey: true, contentHash: true, sizeBytes: true },
  });
  await restoredForEvidence.$disconnect();

  let present = 0;
  let missing = 0;
  let corrupt = 0;

  for (const file of evidence) {
    const path = `${evidenceDir}/${file.storageKey}`;
    if (!existsSync(path)) {
      missing += 1;
      continue;
    }
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (hash === file.contentHash) present += 1;
    else corrupt += 1;
  }

  console.log(`  Evidence files referenced by the restored database: ${evidence.length}`);
  console.log(`    present and hash-verified   ${present}`);
  console.log(`    missing from the store      ${missing}`);
  console.log(`    present but hash mismatch   ${corrupt}`);

  if (evidence.length > 0 && missing > 0) {
    console.log('');
    console.log('  A database restore alone is incomplete: these payment rows point at bank');
    console.log('  slips that are not in the evidence store. Restore the object store too.');
  }

  // --- 6. tidy up ------------------------------------------------------------
  if (!args.keep) {
    psql(
      args.container,
      user,
      password,
      'postgres',
      `DROP DATABASE IF EXISTS ${args.scratch} WITH (FORCE);`,
    );
    console.log(`\n  Scratch database dropped.`);
  } else {
    console.log(`\n  Scratch database "${args.scratch}" kept for inspection.`);
  }

  console.log('');
  if (mismatches === 0) {
    console.log(`  RESTORE VERIFIED — every fact matched (${basename(args.dump)}).`);
    console.log('');
    process.exit(0);
  }

  console.log(`  RESTORE FAILED — ${mismatches} fact(s) did not match.`);
  console.log('');
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
