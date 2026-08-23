/**
 * Moderate concurrency, at pilot scale.
 *
 * Not a benchmark and not a scalability claim. It answers one question: does the application
 * behave itself when ten to twenty people use it at once, which is what a distributor's office
 * actually looks like at nine in the morning?
 *
 * What it deliberately does not do is measure AI latency. A provider call is a network round
 * trip to somebody else's machine; folding it into these numbers would say more about their
 * afternoon than about this application, and the whole design already treats a slow or absent
 * provider as an ordinary outcome.
 *
 * Reads and writes together, because the interesting failures are interactions: a dashboard
 * scan holding a snapshot open while an order tries to take a row lock, a pool exhausted by
 * readers so writers queue behind them.
 *
 * Usage:
 *   pnpm ops:load-test [--users 20] [--seconds 20]
 */
import { config as loadEnv } from 'dotenv';
import { withTenant } from '../src/platform/db';
import { getDashboardSnapshot } from '../src/modules/reporting';
import { listOrders } from '../src/modules/orders';
import { receivables } from '../src/modules/payments';
import { warehouseQueue } from '../src/modules/fulfillment';
import { adjustStock, listProducts } from '../src/modules/catalog';
import { PrismaClient } from '@prisma/client';

loadEnv();

interface Args {
  users: number;
  seconds: number;
  org?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { users: 15, seconds: 15 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--users' && value) args.users = Number(value);
    else if (flag === '--seconds' && value) args.seconds = Number(value);
    else if (flag === '--org' && value) args.org = value;
  }
  return args;
}

interface Sample {
  operation: string;
  ms: number;
  ok: boolean;
}

const samples: Sample[] = [];

async function timed(operation: string, work: () => Promise<unknown>): Promise<void> {
  const startedAt = Date.now();
  try {
    await work();
    samples.push({ operation, ms: Date.now() - startedAt, ok: true });
  } catch {
    samples.push({ operation, ms: Date.now() - startedAt, ok: false });
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set.');

  const admin = new PrismaClient({ datasources: { db: { url } } });
  const organizationId =
    args.org ??
    (
      await admin.organization.findFirstOrThrow({
        where: { salesOrders: { some: {} } },
        select: { id: true },
      })
    ).id;

  const organization = await admin.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { name: true, currency: true, timezone: true },
  });

  // A product to adjust, so the write path exercises a real row lock rather than an insert into
  // an empty table.
  const product = await admin.product.findFirstOrThrow({
    where: { organizationId },
    select: { id: true },
  });
  await admin.$disconnect();

  console.log(`\n=== Load test ===\n`);
  console.log(`  Organization  ${organization.name}`);
  console.log(`  Users         ${args.users} concurrent`);
  console.log(`  Duration      ${args.seconds}s\n`);

  const deadline = Date.now() + args.seconds * 1000;
  const context = {
    organizationId,
    userId: null,
    role: 'OWNER_ADMIN' as const,
    source: 'system' as const,
  };

  /**
   * One simulated user.
   *
   * Weighted the way an office is: mostly reading, occasionally writing. A load test that wrote
   * as often as it read would produce lock contention no real day contains, and would send
   * somebody optimising a problem nobody has.
   */
  async function user(index: number): Promise<void> {
    while (Date.now() < deadline) {
      const roll = (index + samples.length) % 10;

      if (roll === 0) {
        await timed('dashboard', () =>
          withTenant(organizationId, (tx) =>
            getDashboardSnapshot(tx, {
              timezone: organization.timezone,
              currency: organization.currency,
              role: 'OWNER_ADMIN',
              attentionLimit: 12,
            }),
          ),
        );
      } else if (roll === 1) {
        await timed('receivables', () => withTenant(organizationId, (tx) => receivables(tx)));
      } else if (roll === 2) {
        await timed('warehouse-queue', () =>
          withTenant(organizationId, (tx) => warehouseQueue(tx)),
        );
      } else if (roll === 3) {
        // The write path: a real transaction taking a real row lock, and one that appends to the
        // movement ledger, so contention is genuine rather than simulated.
        await timed('stock-adjust', () =>
          withTenant(organizationId, (tx) =>
            adjustStock(tx, context, product.id, { delta: 1, reason: 'load test' }),
          ),
        );
      } else if (roll <= 6) {
        await timed('orders', () => withTenant(organizationId, (tx) => listOrders(tx)));
      } else {
        await timed('products', () => withTenant(organizationId, (tx) => listProducts(tx, {})));
      }
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: args.users }, (_, index) => user(index)));
  const elapsed = (Date.now() - startedAt) / 1000;

  // --- results --------------------------------------------------------------
  const byOperation = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = byOperation.get(sample.operation) ?? [];
    list.push(sample);
    byOperation.set(sample.operation, list);
  }

  console.log('  Operation          count     p50      p95      max    errors');
  console.log('  ' + '-'.repeat(60));

  for (const [operation, list] of [...byOperation].sort()) {
    const times = list.filter((s) => s.ok).map((s) => s.ms);
    const errors = list.filter((s) => !s.ok).length;
    console.log(
      `  ${operation.padEnd(18)} ${String(list.length).padStart(5)}  ` +
        `${String(percentile(times, 50)).padStart(6)}ms ${String(percentile(times, 95)).padStart(6)}ms ` +
        `${String(Math.max(0, ...times)).padStart(6)}ms  ${String(errors).padStart(6)}`,
    );
  }

  const total = samples.length;
  const errors = samples.filter((s) => !s.ok).length;
  const errorRate = total === 0 ? 0 : (errors / total) * 100;

  console.log('');
  console.log(`  Total requests   ${total} in ${elapsed.toFixed(1)}s (${(total / elapsed).toFixed(1)}/s)`);
  console.log(`  Error rate       ${errorRate.toFixed(2)}%`);
  console.log('');

  // A pilot office is not a load generator. Any sustained error rate here is a real defect,
  // most likely pool exhaustion or a transaction conflict the application should have retried.
  if (errorRate > 1) {
    console.log('  ERROR RATE ABOVE 1% — investigate before a pilot.');
    process.exit(1);
  }

  console.log('  Within tolerance for a pilot.');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
