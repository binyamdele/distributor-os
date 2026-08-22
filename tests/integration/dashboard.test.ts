import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { adjustStock } from '@/modules/catalog';
import { receivables } from '@/modules/payments';
import {
  attentionQueue,
  dashboardScopeFor,
  deterministicBrief,
  getDashboardSnapshot,
  narrateBrief,
  snapshotHash,
} from '@/modules/reporting';
import { localDay, previousLocalDay } from '@/platform/time/reporting';
import { MockAIProvider } from '@/platform/ai';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { seedCatalogue } from '../support/catalogue';
import { useMemoryFileStore } from '../support/payment-fixtures';
import { fulfillableOrder } from '../support/fulfillment-fixtures';
import { sentQuotation } from '../support/order-fixtures';

/**
 * The dashboard against a real PostgreSQL.
 *
 * The unit tests pin the boundaries, the trends and the trust boundary. What can only be proved
 * here is that the figures reconcile against the screens they summarise, that an aggregate does
 * not become a way around RBAC, and that one organization's totals never contain another's rows.
 *
 * Nothing is hard-coded. Every expected value is derived from the seeded facts in the test, so a
 * change in the fixtures cannot silently make an assertion vacuous.
 */

const ADDIS = 'Africa/Addis_Ababa';
type Org = Awaited<ReturnType<typeof seedOrg>>;

describe('the snapshot reconciles with the screens it summarises', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('counts only orders raised in the organization-local day', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });

    // Backdate a second order to yesterday, local. It must not appear in today's figure.
    const older = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
      message: '5 bags OPC cement',
    });
    const yesterday = previousLocalDay(ADDIS, new Date());
    await owner.salesOrder.update({
      where: { id: older.orderId },
      data: { createdAt: new Date(yesterday.start.getTime() + 3_600_000) },
    });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    expect(snapshot.sales).not.toBeNull();
    expect(snapshot.sales!.ordersCreated).toBe(1);
    expect(snapshot.sales!.orderValueTodayMinor).toBe(order.grandTotalMinor);
  });

  it('excludes a cancelled order from today value', async () => {
    const kept = await fulfillableOrder(org.organizationId, org.context, { paymentType: 'CREDIT' });
    const dropped = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
      message: '4 bags OPC cement',
    });
    await owner.salesOrder.update({
      where: { id: dropped.orderId },
      data: { status: 'CANCELLED', fulfillmentStatus: 'CANCELLED' },
    });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );
    expect(snapshot.sales!.ordersCreated).toBe(1);
    expect(snapshot.sales!.orderValueTodayMinor).toBe(kept.grandTotalMinor);
  });

  it('counts only confirmed payments, never submitted claims', async () => {
    // A paid cash order gives one confirmed payment; a second order gets a claim nobody has
    // reviewed. The dashboard must show one, not two.
    const paid = await fulfillableOrder(org.organizationId, org.context);
    const unreviewed = await fulfillableOrder(org.organizationId, org.context, {
      leaveUnpaid: true,
      message: '6 bags OPC cement',
    });

    await owner.payment.create({
      data: {
        organizationId: org.organizationId,
        salesOrderId: unreviewed.orderId,
        customerId: unreviewed.customerId,
        status: 'SUBMITTED',
        method: 'BANK_TRANSFER',
        currency: 'ETB',
        amountClaimedMinor: 500_00n,
        submittedById: org.userId,
      },
    });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    const confirmed = await owner.payment.findMany({
      where: { organizationId: org.organizationId, status: 'CONFIRMED' },
    });
    const expected = confirmed.reduce((sum, row) => sum + (row.amountConfirmedMinor ?? 0n), 0n);

    expect(snapshot.cash!.paymentsConfirmedToday).toBe(confirmed.length);
    expect(snapshot.cash!.paymentsConfirmedTodayMinor).toBe(expected);
    expect(snapshot.cash!.paymentsAwaitingReview).toBe(1);
    void paid;
  });

  it('agrees with the receivables screen, santim for santim', async () => {
    // The reconciliation that matters most. Two figures for "outstanding" that differ is how an
    // owner stops believing the dashboard.
    await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
      paymentTermsDays: 30,
    });
    await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
      paymentTermsDays: 15,
      message: '7 bags OPC cement',
    });

    const [snapshot, rows] = await withTenant(org.organizationId, async (tx) => [
      await getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
      await receivables(tx),
    ]);

    const fromScreen = rows.reduce((sum, row) => sum + row.outstandingMinor, 0n);
    expect(snapshot.cash!.outstandingReceivablesMinor).toBe(fromScreen);
    expect(fromScreen).toBeGreaterThan(0n);
  });

  it('splits overdue, due today and due soon without double counting', async () => {
    const overdue = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const dueToday = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
      message: '3 bags OPC cement',
    });

    const today = new Date();
    const localToday = localDay(ADDIS, today);
    // A @db.Date is stored as midnight UTC of the calendar date.
    const asDate = (offsetDays: number) => {
      const base = new Date(localToday.start.getTime() + 12 * 3_600_000);
      const d = new Date(
        Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offsetDays),
      );
      return d;
    };

    await owner.salesOrder.update({
      where: { id: overdue.orderId },
      data: { paymentDueDate: asDate(-5) },
    });
    await owner.salesOrder.update({
      where: { id: dueToday.orderId },
      data: { paymentDueDate: asDate(0) },
    });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    const cash = snapshot.cash!;
    expect(cash.overdueReceivablesMinor).toBe(overdue.grandTotalMinor);
    expect(cash.dueTodayMinor).toBe(dueToday.grandTotalMinor);
    expect(cash.overdueCount).toBe(1);
    // The three buckets are disjoint, so they can never exceed the whole.
    expect(cash.overdueReceivablesMinor + cash.dueTodayMinor + cash.dueSoonMinor).toBeLessThanOrEqual(
      cash.outstandingReceivablesMinor,
    );
  });

  it('counts low stock by the free-stock rule, and follows Phase 7 truth', async () => {
    // The shared test catalogue leaves every threshold at zero, and the rule deliberately
    // ignores a product with no threshold — an unset threshold is "nobody has said what low
    // means here", not "low is zero". So one is set explicitly for this test.
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    await owner.product.update({ where: { id: product.id }, data: { reorderThreshold: 100 } });

    const before = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    // Drive its free stock down to the threshold through the ordinary adjustment path, so the
    // dashboard is reading the same column the warehouse writes.
    await withTenant(org.organizationId, (tx) =>
      adjustStock(tx, org.context, product.id, {
        delta: 100 - product.availableStock,
        reason: 'counted',
      }),
    );

    const after = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    expect(after.inventory!.lowStockProducts).toBe(before.inventory!.lowStockProducts + 1);

    // Derived independently from the catalogue, so the assertion is not just the same code twice.
    const products = await owner.product.findMany({
      where: { organizationId: org.organizationId, active: true },
    });
    const expected = products.filter(
      (row) => row.reorderThreshold > 0 && row.availableStock - row.reservedStock <= row.reorderThreshold,
    ).length;
    expect(after.inventory!.lowStockProducts).toBe(expected);
  });

  it('reports the acceptance rate from decisions, not from quotes sent', async () => {
    await sentQuotation(org.organizationId, org.context, { accept: true });
    await sentQuotation(org.organizationId, org.context, {
      accept: true,
      message: '9 bags OPC cement',
    });
    // A third quote sent and not yet answered must not drag the rate down.
    await sentQuotation(org.organizationId, org.context, { message: '11 bags OPC cement' });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    expect(snapshot.sales!.quotationsAccepted).toBe(2);
    expect(snapshot.sales!.quotationsRejected).toBe(0);
    expect(snapshot.sales!.acceptanceRate).toBe(1);
  });

  it('names the largest order of the day exactly', async () => {
    const small = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
      message: '2 bags OPC cement',
    });
    const large = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
      message: '40 bags OPC cement',
    });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    expect(snapshot.sales!.largestOrder?.orderNumber).toBe(large.orderNumber);
    expect(snapshot.sales!.largestOrder?.valueMinor).toBe(large.grandTotalMinor);
    expect(large.grandTotalMinor).toBeGreaterThan(small.grandTotalMinor);
  });

  it('returns a seven-day series with no gaps', async () => {
    await fulfillableOrder(org.organizationId, org.context, { paymentType: 'CREDIT' });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    expect(snapshot.series).toHaveLength(7);
    // A quiet day is a zero, not a missing point — otherwise a chart implies the business closed.
    expect(snapshot.series.every((point) => typeof point.orderValueMinor === 'bigint')).toBe(true);
    expect(snapshot.series[6]!.dateKey).toBe(snapshot.dateKey);
    // The daily series sums to the seven-day total the trend compares against.
    const seriesTotal = snapshot.series.reduce((sum, point) => sum + point.orderValueMinor, 0n);
    expect(seriesTotal).toBe(snapshot.trends!.orderValue.currentMinor);
  });
});

describe('the attention queue', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('raises an overdue receivable as HIGH with its outstanding amount', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const due = new Date();
    due.setUTCDate(due.getUTCDate() - 9);
    due.setUTCHours(0, 0, 0, 0);
    await owner.salesOrder.update({
      where: { id: order.orderId },
      data: { paymentDueDate: due },
    });

    const items = await withTenant(org.organizationId, (tx) =>
      attentionQueue(tx, {
        timezone: ADDIS,
        asOf: new Date(),
        scope: { money: true, sales: true, operations: true },
      }),
    );

    const overdue = items.find((item) => item.kind === 'OVERDUE_RECEIVABLE');
    expect(overdue).toBeDefined();
    expect(overdue!.severity).toBe('HIGH');
    expect(overdue!.amountMinor).toBe(order.grandTotalMinor);
    expect(overdue!.reference).toBe(order.orderNumber);
    expect(overdue!.href).toBe(`/orders/${order.orderId}`);
  });

  it('raises a reservation shortfall as CRITICAL', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const item = await owner.salesOrderItem.findFirstOrThrow({
      where: { salesOrderId: order.orderId },
    });

    await owner.inventoryDiscrepancy.create({
      data: {
        organizationId: org.organizationId,
        discrepancyNumber: 'IR-000001',
        productId: item.productId!,
        discrepancyType: 'PHYSICAL_SHORTAGE',
        status: 'UNDER_REVIEW',
        systemOnHandQuantity: 100,
        systemReservedQuantity: 80,
        physicalCountQuantity: 60,
        varianceQuantity: -40,
        reservationShortfall: 20,
      },
    });

    const items = await withTenant(org.organizationId, (tx) =>
      attentionQueue(tx, {
        timezone: ADDIS,
        asOf: new Date(),
        scope: { money: true, sales: true, operations: true },
      }),
    );

    const shortfall = items.find((entry) => entry.kind === 'RESERVATION_SHORTFALL');
    expect(shortfall).toBeDefined();
    expect(shortfall!.severity).toBe('CRITICAL');
    // A CRITICAL item is always ahead of every HIGH one, whatever their ages.
    expect(items[0]!.severity).toBe('CRITICAL');
  });

  it('omits the money items entirely for a scope without money', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const due = new Date();
    due.setUTCDate(due.getUTCDate() - 9);
    await owner.salesOrder.update({ where: { id: order.orderId }, data: { paymentDueDate: due } });

    const items = await withTenant(org.organizationId, (tx) =>
      attentionQueue(tx, {
        timezone: ADDIS,
        asOf: new Date(),
        scope: { money: false, sales: false, operations: true },
      }),
    );

    expect(items.some((item) => item.kind === 'OVERDUE_RECEIVABLE')).toBe(false);
    expect(items.some((item) => item.kind === 'PAYMENT_AWAITING_REVIEW')).toBe(false);
    // And no amount leaks through an operational item either.
    expect(items.every((item) => item.amountMinor === null)).toBe(true);
  });

  it('links every item to a page that exists', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const due = new Date();
    due.setUTCDate(due.getUTCDate() - 3);
    await owner.salesOrder.update({ where: { id: order.orderId }, data: { paymentDueDate: due } });

    const items = await withTenant(org.organizationId, (tx) =>
      attentionQueue(tx, {
        timezone: ADDIS,
        asOf: new Date(),
        scope: { money: true, sales: true, operations: true },
      }),
    );

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.href).toMatch(
        /^\/(orders|quotations|payments|exceptions|returns|deliveries|warehouse)\/[0-9a-f-]{36}$/,
      );
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.reference.length).toBeGreaterThan(0);
    }
  });
});

describe('aggregates do not bypass RBAC', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);

    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const due = new Date();
    due.setUTCDate(due.getUTCDate() - 9);
    await owner.salesOrder.update({ where: { id: order.orderId }, data: { paymentDueDate: due } });
  });

  it('gives a warehouse user no financial section at all', async () => {
    // §30: a user who may not read payments must not learn the totals from an aggregate.
    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'WAREHOUSE' }),
    );

    expect(snapshot.cash).toBeNull();
    expect(snapshot.sales).toBeNull();
    expect(snapshot.operations).not.toBeNull();

    // Not a rendering choice — the figures are not in the object at all.
    const serialised = JSON.stringify(snapshot, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialised).not.toContain('outstandingReceivables');
    expect(serialised).not.toContain('overdueReceivables');
    expect(snapshot.attention.every((item) => item.amountMinor === null)).toBe(true);
  });

  it('gives a warehouse user an operational queue that is genuinely useful', async () => {
    // Not vacuous: withholding money must not leave the role with an empty dashboard.
    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'WAREHOUSE' }),
    );
    expect(snapshot.operations).not.toBeNull();
    expect(snapshot.inventory).not.toBeNull();
  });

  it('gives finance the money sections', async () => {
    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'FINANCE' }),
    );
    expect(snapshot.cash).not.toBeNull();
    expect(snapshot.cash!.overdueReceivablesMinor).toBeGreaterThan(0n);
  });

  it('gives a salesperson the pipeline and no money', async () => {
    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'SALESPERSON' }),
    );
    expect(snapshot.pipeline).not.toBeNull();
    expect(snapshot.cash).toBeNull();
    // The sales section exists but carries no largest-order figure, which needs money scope.
    expect(snapshot.sales!.largestOrder).toBeNull();
  });

  it('scopes the brief the same way the snapshot is scoped', async () => {
    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'WAREHOUSE' }),
    );
    const brief = deterministicBrief(snapshot);

    expect(JSON.stringify(brief)).not.toMatch(/overdue|ETB/i);
  });

  it('derives the scope from permissions rather than a second list', () => {
    expect(dashboardScopeFor('WAREHOUSE').money).toBe(false);
    expect(dashboardScopeFor('OWNER_ADMIN').money).toBe(true);
  });
});

describe('tenant isolation', () => {
  let orgA: Org;
  let orgB: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    orgA = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    orgB = await seedOrg('Bole Trading', 'OWNER_ADMIN');
    await seedCatalogue(orgA.organizationId);
    await seedCatalogue(orgB.organizationId);
  });

  it('never includes another organization in any total, count or queue', async () => {
    // Org B gets everything: orders, an overdue receivable, a discrepancy, a payment claim.
    const theirOrder = await fulfillableOrder(orgB.organizationId, orgB.context, {
      paymentType: 'CREDIT',
    });
    const due = new Date();
    due.setUTCDate(due.getUTCDate() - 9);
    await owner.salesOrder.update({
      where: { id: theirOrder.orderId },
      data: { paymentDueDate: due },
    });

    const theirItem = await owner.salesOrderItem.findFirstOrThrow({
      where: { salesOrderId: theirOrder.orderId },
    });
    await owner.inventoryDiscrepancy.create({
      data: {
        organizationId: orgB.organizationId,
        discrepancyNumber: 'IR-000900',
        productId: theirItem.productId!,
        discrepancyType: 'PHYSICAL_SHORTAGE',
        status: 'OPEN',
        systemOnHandQuantity: 50,
        systemReservedQuantity: 10,
        physicalCountQuantity: 40,
        varianceQuantity: -10,
      },
    });

    // Org A has nothing at all.
    const snapshot = await withTenant(orgA.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    expect(snapshot.sales!.ordersCreated).toBe(0);
    expect(snapshot.sales!.orderValueTodayMinor).toBe(0n);
    expect(snapshot.cash!.outstandingReceivablesMinor).toBe(0n);
    expect(snapshot.cash!.overdueReceivablesMinor).toBe(0n);
    expect(snapshot.cash!.overdueCount).toBe(0);
    expect(snapshot.inventory!.openDiscrepancies).toBe(0);
    expect(snapshot.attention).toHaveLength(0);
    expect(snapshot.series.every((point) => point.orderValueMinor === 0n)).toBe(true);

    // Not vacuous: Org B sees its own.
    const theirs = await withTenant(orgB.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );
    expect(theirs.sales!.ordersCreated).toBe(1);
    expect(theirs.cash!.overdueReceivablesMinor).toBeGreaterThan(0n);
    expect(theirs.attention.length).toBeGreaterThan(0);
  });

  it('never leaks a customer name through an attention item', async () => {
    await fulfillableOrder(orgB.organizationId, orgB.context, {
      paymentType: 'CREDIT',
      companyName: 'Bole Secret Holdings',
    });

    const items = await withTenant(orgA.organizationId, (tx) =>
      attentionQueue(tx, {
        timezone: ADDIS,
        asOf: new Date(),
        scope: { money: true, sales: true, operations: true },
      }),
    );

    expect(JSON.stringify(items)).not.toContain('Bole Secret Holdings');
  });
});

describe('the empty organization', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Brand New Distributor', 'OWNER_ADMIN');
  });

  it('produces zeroes and a calm brief, never NaN or undefined', async () => {
    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    expect(snapshot.sales!.ordersCreated).toBe(0);
    expect(snapshot.sales!.acceptanceRate).toBeNull();
    expect(snapshot.cash!.outstandingReceivablesMinor).toBe(0n);
    expect(snapshot.attention).toHaveLength(0);
    expect(snapshot.series).toHaveLength(7);
    // Both periods empty, so no percentage is claimed.
    expect(snapshot.trends!.orderValue.bothEmpty).toBe(true);
    expect(snapshot.trends!.orderValue.percentChange).toBeNull();

    const brief = deterministicBrief(snapshot);
    expect(brief.summary).toBe('Nothing has been recorded yet today.');
    expect(brief.attention).toHaveLength(0);

    const text = JSON.stringify({ snapshot, brief }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
    expect(text).not.toContain('undefined');
  });
});

describe('the snapshot hash', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('is stable across two reads of the same position', async () => {
    await fulfillableOrder(org.organizationId, org.context, { paymentType: 'CREDIT' });
    const asOf = new Date();

    const [first, second] = await withTenant(org.organizationId, async (tx) => [
      await getDashboardSnapshot(tx, {
        timezone: ADDIS,
        currency: 'ETB',
        role: 'OWNER_ADMIN',
        asOf,
      }),
      await getDashboardSnapshot(tx, {
        timezone: ADDIS,
        currency: 'ETB',
        role: 'OWNER_ADMIN',
        asOf,
      }),
    ]);

    expect(snapshotHash(first)).toBe(snapshotHash(second));
  });

  it('changes when a figure changes', async () => {
    const asOf = new Date();
    const before = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN', asOf }),
    );

    await fulfillableOrder(org.organizationId, org.context, { paymentType: 'CREDIT' });

    const after = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN', asOf }),
    );

    expect(snapshotHash(after)).not.toBe(snapshotHash(before));
  });
});

describe('the brief over real data', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('states the same figures the snapshot holds', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );
    const brief = deterministicBrief(snapshot);

    expect(brief.summary).toContain('1 sales order');
    expect(brief.highlights.join(' ')).toContain(order.orderNumber);
  });

  it('narrates through the mock and stays grounded in those figures', async () => {
    await fulfillableOrder(org.organizationId, org.context, { paymentType: 'CREDIT' });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    const provider = new MockAIProvider();
    const narrated = await narrateBrief(snapshot, { useAi: true, provider });

    expect(narrated.brief.source).toBe('AI');
    expect(narrated.fallbackReason).toBeNull();
    // And the payload it was given carried no identity.
    expect(JSON.stringify(provider.briefInputsSeen)).not.toContain('ABC Construction');
  });

  it('falls back to a complete brief when the provider fails', async () => {
    await fulfillableOrder(org.organizationId, org.context, { paymentType: 'CREDIT' });

    const snapshot = await withTenant(org.organizationId, (tx) =>
      getDashboardSnapshot(tx, { timezone: ADDIS, currency: 'ETB', role: 'OWNER_ADMIN' }),
    );

    const provider = new MockAIProvider();
    provider.setBriefFailure('PROVIDER_ERROR', 'down');

    const narrated = await narrateBrief(snapshot, { useAi: true, provider });
    expect(narrated.brief.source).toBe('DETERMINISTIC');
    expect(narrated.brief.summary).toContain('1 sales order');
  });
});
