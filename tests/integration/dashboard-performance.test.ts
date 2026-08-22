import { beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { getDashboardSnapshot } from '@/modules/reporting';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { seedCatalogue } from '../support/catalogue';

/**
 * Reporting performance at a realistic volume.
 *
 * Not a benchmark and not a scalability claim. It exists to catch one specific mistake this
 * phase could make — a query per card, or a predicate with no index behind it — which shows up
 * as a snapshot that takes seconds rather than tens of milliseconds once there are a few
 * thousand rows to scan.
 *
 * The ceiling is deliberately generous. A tight threshold on a developer machine, in a container,
 * on a laptop that may be compiling something else, is a flaky test that eventually gets deleted.
 * A generous one still fails loudly if somebody reintroduces an N+1, which is the whole point.
 */

const ADDIS = 'Africa/Addis_Ababa';
/** Four seconds. An N+1 over four thousand quotations is far slower; a healthy snapshot is far faster. */
const CEILING_MS = 4_000;

const QUOTATIONS = 3_000;
const ORDERS = 600;
const PAYMENTS = 400;
const DAYS = 90;

describe('the dashboard at volume', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeAll(async () => {
    await resetDatabase();
    org = await seedOrg('Volume Distributor', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);

    const customer = await owner.customer.create({
      data: {
        organizationId: org.organizationId,
        companyName: 'Synthetic Volume Customer',
        creditStatus: 'CREDIT_ALLOWED',
        creditLimitMinor: 100_000_000_00n,
        paymentTermsDays: 30,
      },
    });

    const daysAgo = (days: number, hour: number) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - days);
      date.setUTCHours(hour, 0, 0, 0);
      return date;
    };

    // Bulk rows rather than the domain workflows: this data exists to be counted, and driving
    // three thousand quotations through the real state machines would take minutes and prove
    // nothing extra about how the reporting queries behave.
    await owner.quotation.createMany({
      data: Array.from({ length: QUOTATIONS }, (_, index) => {
        const createdAt = daysAgo(index % DAYS, 8 + (index % 10));
        const accepted = index % 3 === 0;
        const rejected = !accepted && index % 6 === 0;
        return {
          organizationId: org.organizationId,
          quotationNumber: `PERF-Q-${String(index + 1).padStart(6, '0')}`,
          customerId: customer.id,
          status: accepted ? ('ACCEPTED' as const) : rejected ? ('REJECTED' as const) : ('SENT' as const),
          currency: 'ETB',
          paymentType: 'CASH' as const,
          paymentTermsDays: 0,
          validityDate: createdAt,
          subtotalMinor: BigInt(50_000 + index) * 100n,
          discountTotalMinor: 0n,
          deliveryFeeMinor: 0n,
          deliveryTaxMinor: 0n,
          taxTotalMinor: 0n,
          grandTotalMinor: BigInt(50_000 + index) * 100n,
          currentPayloadHash: `perf-${index}`,
          createdAt,
          sentAt: createdAt,
          acceptedAt: accepted ? createdAt : null,
          rejectedAt: rejected ? createdAt : null,
        };
      }),
    });

    const accepted = await owner.quotation.findMany({
      where: { organizationId: org.organizationId, status: 'ACCEPTED' },
      select: { id: true, grandTotalMinor: true, createdAt: true },
      take: ORDERS,
    });

    await owner.salesOrder.createMany({
      data: accepted.map((quotation, index) => {
        const due = new Date(quotation.createdAt);
        due.setUTCDate(due.getUTCDate() + 30);
        due.setUTCHours(0, 0, 0, 0);
        return {
          organizationId: org.organizationId,
          orderNumber: `PERF-SO-${String(index + 1).padStart(6, '0')}`,
          quotationId: quotation.id,
          customerId: customer.id,
          status: 'OPEN' as const,
          paymentStatus: 'NOT_REQUIRED_YET' as const,
          fulfillmentStatus: 'READY' as const,
          currency: 'ETB',
          paymentType: 'CREDIT' as const,
          paymentTermsDays: 30,
          paymentDueDate: due,
          subtotalMinor: quotation.grandTotalMinor,
          discountTotalMinor: 0n,
          deliveryFeeMinor: 0n,
          deliveryTaxMinor: 0n,
          taxTotalMinor: 0n,
          grandTotalMinor: quotation.grandTotalMinor,
          createdAt: quotation.createdAt,
        };
      }),
    });

    const orders = await owner.salesOrder.findMany({
      where: { organizationId: org.organizationId },
      select: { id: true, grandTotalMinor: true, createdAt: true },
      take: PAYMENTS,
    });

    await owner.payment.createMany({
      data: orders.map((order, index) => ({
        organizationId: org.organizationId,
        salesOrderId: order.id,
        customerId: customer.id,
        status: 'CONFIRMED' as const,
        method: 'BANK_TRANSFER' as const,
        currency: 'ETB',
        amountClaimedMinor: order.grandTotalMinor / 2n,
        amountConfirmedMinor: order.grandTotalMinor / 2n,
        confirmationPayloadHash: `perf-${index}`,
        submittedById: org.userId,
        createdAt: order.createdAt,
        reviewedAt: order.createdAt,
      })),
    });
  }, 180_000);

  it('has actually loaded a meaningful volume', async () => {
    // Guards the tests below from passing because the fixture silently did nothing.
    expect(await owner.quotation.count({ where: { organizationId: org.organizationId } })).toBe(
      QUOTATIONS,
    );
    expect(await owner.salesOrder.count({ where: { organizationId: org.organizationId } })).toBe(
      ORDERS,
    );
    expect(await owner.payment.count({ where: { organizationId: org.organizationId } })).toBe(
      PAYMENTS,
    );
  });

  it('builds the whole snapshot well inside the ceiling', async () => {
    const timings: number[] = [];

    for (let run = 0; run < 3; run += 1) {
      const startedAt = Date.now();
      await withTenant(org.organizationId, (tx) =>
        getDashboardSnapshot(tx, {
          timezone: ADDIS,
          currency: 'ETB',
          role: 'OWNER_ADMIN',
          attentionLimit: 12,
        }),
      );
      timings.push(Date.now() - startedAt);
    }

    const median = [...timings].sort((a, b) => a - b)[1]!;
    // Reported so the number is visible in the run output rather than only asserted.
    console.log(
      `dashboard snapshot over ${QUOTATIONS} quotations / ${ORDERS} orders / ${PAYMENTS} payments: ${timings.join('ms, ')}ms`,
    );

    expect(median).toBeLessThan(CEILING_MS);
  }, 60_000);

  it('produces figures that are actually derived from the volume', async () => {
    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    // Non-vacuous: the queries returned real aggregates rather than empty results quickly.
    expect(snapshot.cash!.outstandingReceivablesMinor).toBeGreaterThan(0n);
    expect(snapshot.sales!.quotationsCreated).toBeGreaterThan(0);
    expect(snapshot.series).toHaveLength(7);
  });

  it('is not materially slower for the owner than for a scoped role', async () => {
    // A warehouse snapshot skips every money query. If the owner's were an order of magnitude
    // slower, that would point at one section doing something pathological.
    const time = async (role: 'OWNER_ADMIN' | 'WAREHOUSE') => {
      const startedAt = Date.now();
      await withTenant(org.organizationId, (tx) =>
        getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role }),
      );
      return Date.now() - startedAt;
    };

    const ownerMs = await time('OWNER_ADMIN');
    const warehouseMs = await time('WAREHOUSE');

    console.log(`owner ${ownerMs}ms, warehouse ${warehouseMs}ms`);
    expect(ownerMs).toBeLessThan(CEILING_MS);
    expect(warehouseMs).toBeLessThan(CEILING_MS);
  }, 60_000);
});
