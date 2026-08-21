import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { getQuotation, recordAcceptance, recordRejection } from '@/modules/quotations';
import { completeFollowUp, followUpQueue, followUpsFor } from '@/modules/followups';
import { cancelOrder, createFromQuotation, getOrder } from '@/modules/orders';
import { conversionMetrics, followUpMetrics } from '@/modules/orders/metrics';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { sentQuotation } from '../support/order-fixtures';

/**
 * The aggregate invariant that must never drift.
 *
 * `stock_reservations` rows are the source of truth; `product.reserved_stock` is a maintained
 * cache of the ACTIVE ones. Asserted after every operation that touches either.
 */
async function assertReservedAggregateMatches(organizationId: string): Promise<void> {
  const products = await owner.product.findMany({ where: { organizationId } });
  for (const product of products) {
    const active = await owner.stockReservation.aggregate({
      where: { organizationId, productId: product.id, status: 'ACTIVE' },
      _sum: { quantity: true },
    });
    expect(
      product.reservedStock,
      `${product.sku}: reserved_stock disagrees with its ACTIVE reservations`,
    ).toBe(active._sum.quantity ?? 0);
  }
}

describe('follow-ups', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
  });

  it('are scheduled the moment a quotation is sent', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);

    const followUps = await withTenant(org.organizationId, (tx) => followUpsFor(tx, quotationId));
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ sequence: 1, status: 'DUE' });
  });

  it('fall due one configured interval after sending', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);
    const quotation = await owner.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    const [followUp] = await owner.quotationFollowUp.findMany({ where: { quotationId } });

    const expected = new Date(quotation.sentAt!.getTime());
    expected.setUTCDate(expected.getUTCDate() + 2);
    expect(followUp!.dueAt.toISOString()).toBe(expected.toISOString());
  });

  it('appear in the queue once due', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);

    // Nothing is due yet; two days from now it is.
    const now = await withTenant(org.organizationId, (tx) => followUpQueue(tx));
    expect(now).toEqual([]);

    const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const due = await withTenant(org.organizationId, (tx) => followUpQueue(tx, { now: later }));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ quotationId, sequence: 1, overdue: true });
    expect(due[0]?.customerName).toBe('ABC Construction PLC');
  });

  it('can be completed with an outcome', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);
    const [followUp] = await owner.quotationFollowUp.findMany({ where: { quotationId } });

    const result = await withTenant(org.organizationId, (tx) =>
      completeFollowUp(tx, org.context, followUp!.id, {
        outcome: 'CUSTOMER_CONSIDERING',
        note: 'Wants to check the site schedule',
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.nextFollowUpId).toBeNull();

    const stored = await owner.quotationFollowUp.findUniqueOrThrow({ where: { id: followUp!.id } });
    expect(stored).toMatchObject({
      status: 'COMPLETED',
      outcome: 'CUSTOMER_CONSIDERING',
      completedById: org.userId,
    });
  });

  it('schedule another only when explicitly asked', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);
    const [followUp] = await owner.quotationFollowUp.findMany({ where: { quotationId } });

    const result = await withTenant(org.organizationId, (tx) =>
      completeFollowUp(tx, org.context, followUp!.id, {
        outcome: 'NO_RESPONSE',
        scheduleNext: true,
      }),
    );
    expect(result.ok && result.value.nextFollowUpId).not.toBeNull();
    expect(await owner.quotationFollowUp.count({ where: { quotationId } })).toBe(2);
  });

  it('stop at the configured cap rather than recurring forever', async () => {
    await owner.organizationSettings.update({
      where: { organizationId: org.organizationId },
      data: { maxFollowUpCount: 2 },
    });

    const { quotationId } = await sentQuotation(org.organizationId, org.context);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const open = await owner.quotationFollowUp.findFirst({
        where: { quotationId, status: 'DUE' },
        orderBy: { sequence: 'asc' },
      });
      if (!open) break;
      await withTenant(org.organizationId, (tx) =>
        completeFollowUp(tx, org.context, open.id, { outcome: 'NO_RESPONSE', scheduleNext: true }),
      );
    }

    // Two chases, and the second refuses to spawn a third.
    expect(await owner.quotationFollowUp.count({ where: { quotationId } })).toBe(2);
  });

  it('cannot be completed twice', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);
    const [followUp] = await owner.quotationFollowUp.findMany({ where: { quotationId } });

    await withTenant(org.organizationId, (tx) =>
      completeFollowUp(tx, org.context, followUp!.id, { outcome: 'NO_RESPONSE' }),
    );
    const second = await withTenant(org.organizationId, (tx) =>
      completeFollowUp(tx, org.context, followUp!.id, { outcome: 'OTHER' }),
    );

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('are closed when the customer accepts', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);

    await withTenant(org.organizationId, (tx) =>
      recordAcceptance(tx, org.context, quotationId, { source: 'PHONE' }),
    );

    const followUps = await withTenant(org.organizationId, (tx) => followUpsFor(tx, quotationId));
    expect(followUps.every((followUp) => followUp.status === 'CANCELLED')).toBe(true);

    // And nobody is asked to chase it.
    const later = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(await withTenant(org.organizationId, (tx) => followUpQueue(tx, { now: later }))).toEqual(
      [],
    );
  });

  it('are closed when the customer declines', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);
    await withTenant(org.organizationId, (tx) =>
      recordRejection(tx, org.context, quotationId, { reason: 'PRICE' }),
    );

    const followUps = await withTenant(org.organizationId, (tx) => followUpsFor(tx, quotationId));
    expect(followUps.every((followUp) => followUp.status === 'CANCELLED')).toBe(true);
  });

  it('are audited', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);
    const [followUp] = await owner.quotationFollowUp.findMany({ where: { quotationId } });
    await withTenant(org.organizationId, (tx) =>
      completeFollowUp(tx, org.context, followUp!.id, { outcome: 'NO_RESPONSE' }),
    );

    const actions = (await owner.auditEvent.findMany({})).map((event) => event.action);
    expect(actions).toContain('followup.created');
    expect(actions).toContain('followup.completed');
  });
});

describe('acceptance and rejection', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
  });

  it('records who said what, and how they said it', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);

    const result = await withTenant(org.organizationId, (tx) =>
      recordAcceptance(tx, org.context, quotationId, {
        source: 'PHONE',
        note: 'Tewodros confirmed on the phone',
      }),
    );
    expect(result.ok).toBe(true);

    const quotation = await owner.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    expect(quotation).toMatchObject({
      status: 'ACCEPTED',
      acceptanceSource: 'PHONE',
      acceptedById: org.userId,
    });
    expect(quotation.acceptedAt).not.toBeNull();
  });

  it('says plainly that it is a record, not a signature', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);
    await withTenant(org.organizationId, (tx) =>
      recordAcceptance(tx, org.context, quotationId, { source: 'MESSAGE' }),
    );

    const [event] = await owner.auditEvent.findMany({ where: { action: 'quotation.accepted' } });
    expect((event?.newState as Record<string, unknown>).basis).toBe('recorded_by_staff');
  });

  it('refuses a quotation that was never sent', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context, {
      stopAt: 'APPROVED',
    });

    const result = await withTenant(org.organizationId, (tx) =>
      recordAcceptance(tx, org.context, quotationId, { source: 'PHONE' }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses an expired quotation, on expiry grounds', async () => {
    // The validity date is set before approval, so the approval covers this exact payload and
    // the refusal can only be about expiry. Backdating it *after* approval would invalidate the
    // fingerprint instead, and the test would silently assert a different invariant.
    const { quotationId } = await sentQuotation(org.organizationId, org.context, {
      validityDate: new Date('2020-01-01T00:00:00.000Z'),
    });

    const quotation = await owner.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    expect(quotation.approvedPayloadHash).toBe(quotation.currentPayloadHash);

    const result = await withTenant(org.organizationId, (tx) =>
      recordAcceptance(tx, org.context, quotationId, { source: 'PHONE' }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/validity date/i);
    expect(result.ok === false && result.error.message).not.toMatch(/approved/i);
  });

  it('separately, invalidates the approval when the validity date is edited', async () => {
    // The other half of the pair. Both invariants are real and both must hold: an expired
    // quotation cannot be accepted, and moving the date after approval withdraws the approval.
    const { quotationId } = await sentQuotation(org.organizationId, org.context, {
      stopAt: 'APPROVED',
    });

    const before = await owner.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    expect(before.approvedPayloadHash).toBe(before.currentPayloadHash);

    const { setValidityDate } = await import('@/modules/quotations');
    await withTenant(org.organizationId, (tx) =>
      setValidityDate(tx, org.context, quotationId, new Date('2027-01-31T00:00:00.000Z')),
    );

    const after = await owner.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    expect(after.status).toBe('DRAFT');
    expect(after.approvedPayloadHash).toBeNull();
    expect(after.currentPayloadHash).not.toBe(before.currentPayloadHash);
  });

  it('refuses when the figures no longer match the approval', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);

    // Tamper directly, bypassing every application code path.
    const line = await owner.quotationItem.findFirstOrThrow({ where: { quotationId } });
    await owner.quotationItem.update({ where: { id: line.id }, data: { quantity: 9_999 } });

    const result = await withTenant(org.organizationId, (tx) =>
      recordAcceptance(tx, org.context, quotationId, { source: 'PHONE' }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/no longer match what was approved/i);
  });

  it('records a rejection reason when one is given, and copes without', async () => {
    const first = await sentQuotation(org.organizationId, org.context);
    await withTenant(org.organizationId, (tx) =>
      recordRejection(tx, org.context, first.quotationId, { reason: 'COMPETITOR' }),
    );
    expect(
      (await owner.quotation.findUniqueOrThrow({ where: { id: first.quotationId } }))
        .rejectionReason,
    ).toBe('COMPETITOR');

    const second = await sentQuotation(org.organizationId, org.context, {
      companyName: 'XYZ Trading',
    });
    const result = await withTenant(org.organizationId, (tx) =>
      recordRejection(tx, org.context, second.quotationId, {}),
    );
    expect(result.ok).toBe(true);
    expect(
      (await owner.quotation.findUniqueOrThrow({ where: { id: second.quotationId } }))
        .rejectionReason,
    ).toBeNull();
  });
});

describe('converting an accepted quotation', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let quotationId: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
    ({ quotationId } = await sentQuotation(org.organizationId, org.context, { accept: true }));
  });

  async function convert(deliveryRequired = false) {
    return withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId, deliveryRequired }),
    );
  }

  it('copies the commercial figures santim for santim', async () => {
    const quotation = await withTenant(org.organizationId, (tx) => getQuotation(tx, quotationId));
    if (!quotation.ok) throw new Error('unreachable');

    const created = await convert();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const order = await withTenant(org.organizationId, (tx) => getOrder(tx, created.value.id));
    if (!order.ok) throw new Error('unreachable');

    expect(order.value.grandTotalMinor).toBe(quotation.value.grandTotalMinor);
    expect(order.value.subtotalMinor).toBe(quotation.value.subtotalMinor);
    expect(order.value.discountTotalMinor).toBe(quotation.value.discountTotalMinor);
    expect(order.value.taxTotalMinor).toBe(quotation.value.taxTotalMinor);
    expect(order.value.deliveryFeeMinor).toBe(quotation.value.deliveryFeeMinor);
  });

  it('copies each line snapshot rather than re-reading the catalogue', async () => {
    // Move the catalogue before converting. The order must carry the agreed price.
    await owner.product.updateMany({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      data: { sellingPriceMinor: 999_900n, name: 'Renamed Cement', taxRateBp: 0 },
    });

    const created = await convert();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const line = await owner.salesOrderItem.findFirstOrThrow({
      where: { salesOrderId: created.value.id, skuSnapshot: 'CEM-OPC-50' },
    });
    expect(line.descriptionSnapshot).toBe('OPC Cement 50kg');
    expect(line.listUnitPriceMinor).toBe(125_000n);
    expect(line.taxRateBp).toBe(1500);
  });

  it('numbers the order SO-000001', async () => {
    const created = await convert();
    expect(created.ok && created.value.orderNumber).toBe('SO-000001');
  });

  it('reserves stock and keeps the aggregate honest', async () => {
    const before = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });

    const created = await convert();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const after = await owner.product.findUniqueOrThrow({ where: { id: before.id } });
    // On-hand is untouched: goods have not left the yard.
    expect(after.availableStock).toBe(before.availableStock);
    expect(after.reservedStock).toBe(before.reservedStock + 500);

    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: created.value.id },
    });
    expect(reservations).toHaveLength(3);
    expect(reservations.every((reservation) => reservation.status === 'ACTIVE')).toBe(true);

    await assertReservedAggregateMatches(org.organizationId);
  });

  it('leaves a cash order unpaid and not ready for the warehouse', async () => {
    const created = await convert();
    if (!created.ok) throw new Error('unreachable');

    const order = await owner.salesOrder.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(order.paymentStatus).toBe('UNPAID');
    expect(order.fulfillmentStatus).toBe('NOT_READY');
    expect(order.paymentDueDate).toBeNull();
  });

  it('lets a credit order be prepared, with nothing owed yet', async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
    const credit = await sentQuotation(org.organizationId, org.context, {
      accept: true,
      paymentType: 'CREDIT',
      paymentTermsDays: 30,
    });

    const created = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId: credit.quotationId }),
    );
    if (!created.ok) throw new Error(`conversion failed: ${created.error.message}`);

    const order = await owner.salesOrder.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(order.paymentStatus).toBe('NOT_REQUIRED_YET');
    expect(order.fulfillmentStatus).toBe('READY');
    expect(order.paymentDueDate).not.toBeNull();
  });

  it('snapshots the delivery address when delivery is wanted', async () => {
    const created = await convert(true);
    if (!created.ok) throw new Error('unreachable');
    const order = await owner.salesOrder.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(order.deliveryRequired).toBe(true);
    expect(order.deliveryAddressSnapshot).toBe('Bole Bulbula, Addis Ababa');
  });

  it('refuses a quotation that has not been accepted', async () => {
    const notAccepted = await sentQuotation(org.organizationId, org.context, {
      companyName: 'XYZ Trading',
    });

    const result = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId: notAccepted.quotationId }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('is audited', async () => {
    const created = await convert();
    if (!created.ok) throw new Error('unreachable');

    const actions = (
      await owner.auditEvent.findMany({ where: { entityId: created.value.id } })
    ).map((event) => event.action);
    expect(actions).toContain('order.created');
    expect(actions).toContain('order.stock_reserved');
  });
});

describe('insufficient stock', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let quotationId: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
    ({ quotationId } = await sentQuotation(org.organizationId, org.context, { accept: true }));
  });

  it('refuses in full and reserves nothing', async () => {
    // The yard emptied between the quotation going out and the customer answering.
    await owner.product.updateMany({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      data: { availableStock: 420 },
    });

    const result = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INSUFFICIENT_STOCK');

    // Nothing partial: no order, no reservations, no aggregate movement anywhere.
    expect(await owner.salesOrder.count()).toBe(0);
    expect(await owner.stockReservation.count()).toBe(0);
    await assertReservedAggregateMatches(org.organizationId);
    const products = await owner.product.findMany({ where: { organizationId: org.organizationId } });
    expect(products.every((product) => product.reservedStock === 0)).toBe(true);
  });

  it('reports the exact shortfall per product', async () => {
    await owner.product.updateMany({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      data: { availableStock: 420 },
    });

    const result = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const shortfalls = result.error.details?.shortfalls as {
      sku: string;
      requested: number;
      availableToReserve: number;
      shortfall: number;
    }[];

    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]).toMatchObject({
      sku: 'CEM-OPC-50',
      requested: 500,
      availableToReserve: 420,
      shortfall: 80,
    });
  });

  it('leaves the accepted quotation exactly as it was', async () => {
    const before = await owner.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    await owner.product.updateMany({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      data: { availableStock: 1 },
    });

    await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );

    const after = await owner.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    expect(after.status).toBe('ACCEPTED');
    expect(after.grandTotalMinor).toBe(before.grandTotalMinor);
    expect(after.currentPayloadHash).toBe(before.currentPayloadHash);
  });

  it('records the refusal, because a sale lost to stock is worth counting', async () => {
    await owner.product.updateMany({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      data: { availableStock: 1 },
    });

    await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );

    const [event] = await owner.auditEvent.findMany({
      where: { action: 'order.creation_refused_insufficient_stock' },
    });
    expect(event).toBeDefined();
  });

  it('succeeds once stock is replenished', async () => {
    await owner.product.updateMany({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      data: { availableStock: 100 },
    });
    expect(
      (await withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId }),
      )).ok,
    ).toBe(false);

    await owner.product.updateMany({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      data: { availableStock: 5_000 },
    });
    const retry = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );
    expect(retry.ok).toBe(true);
    await assertReservedAggregateMatches(org.organizationId);
  });
});

describe('one order per quotation', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let quotationId: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
    ({ quotationId } = await sentQuotation(org.organizationId, org.context, { accept: true }));
  });

  it('returns the existing order on a second request', async () => {
    const first = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );
    const second = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.alreadyExisted).toBe(true);
    expect(await owner.salesOrder.count()).toBe(1);
  });

  it('does not double-reserve on a second request', async () => {
    await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );
    await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.reservedStock).toBe(500);
    await assertReservedAggregateMatches(org.organizationId);
  });

  it('creates exactly one order when the button is double-clicked', async () => {
    // Concurrent, not sequential. The application check cannot see the other transaction, so
    // this is the partial unique index doing the work.
    const results = await Promise.allSettled([
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId }),
      ),
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId }),
      ),
    ]);

    const orders = await owner.salesOrder.findMany({ where: { quotationId } });
    expect(orders).toHaveLength(1);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.reservedStock).toBe(500);
    await assertReservedAggregateMatches(org.organizationId);
  });

  it('permits a fresh conversion after the first order was cancelled', async () => {
    const first = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );
    if (!first.ok) throw new Error('unreachable');

    await withTenant(org.organizationId, (tx) =>
      cancelOrder(tx, org.context, first.value.id, 'customer changed their mind'),
    );

    const second = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );
    expect(second.ok).toBe(true);
    expect(second.ok && second.value.id).not.toBe(first.value.id);
    await assertReservedAggregateMatches(org.organizationId);
  });
});

describe('cancellation', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let orderId: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
    const { quotationId } = await sentQuotation(org.organizationId, org.context, { accept: true });
    const created = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId }),
    );
    if (!created.ok) throw new Error('setup failed');
    orderId = created.value.id;
  });

  it('releases exactly what the order reserved', async () => {
    const before = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(before.reservedStock).toBe(500);

    const result = await withTenant(org.organizationId, (tx) =>
      cancelOrder(tx, org.context, orderId, 'site postponed'),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.released).toBe(3);

    const after = await owner.product.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.reservedStock).toBe(0);
    // On-hand never moved: nothing was ever shipped.
    expect(after.availableStock).toBe(before.availableStock);
    await assertReservedAggregateMatches(org.organizationId);
  });

  it('marks the reservations released rather than deleting them', async () => {
    await withTenant(org.organizationId, (tx) => cancelOrder(tx, org.context, orderId, 'x'));

    const reservations = await owner.stockReservation.findMany({ where: { salesOrderId: orderId } });
    expect(reservations).toHaveLength(3);
    expect(reservations.every((reservation) => reservation.status === 'RELEASED')).toBe(true);
    expect(reservations.every((reservation) => reservation.releasedAt !== null)).toBe(true);
  });

  it('cannot release twice', async () => {
    await withTenant(org.organizationId, (tx) => cancelOrder(tx, org.context, orderId, 'x'));
    const second = await withTenant(org.organizationId, (tx) =>
      cancelOrder(tx, org.context, orderId, 'x again'),
    );

    expect(second.ok).toBe(true);
    expect(second.ok && second.value.alreadyCancelled).toBe(true);
    expect(second.ok && second.value.released).toBe(0);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.reservedStock).toBe(0);
    await assertReservedAggregateMatches(org.organizationId);
  });

  it('does not double-release when cancelled concurrently', async () => {
    await Promise.allSettled([
      withTenant(org.organizationId, (tx) => cancelOrder(tx, org.context, orderId, 'a')),
      withTenant(org.organizationId, (tx) => cancelOrder(tx, org.context, orderId, 'b')),
    ]);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.reservedStock).toBe(0);
    await assertReservedAggregateMatches(org.organizationId);
  });

  it('leaves the quotation alone', async () => {
    const before = await owner.salesOrder.findUniqueOrThrow({ where: { id: orderId } });
    await withTenant(org.organizationId, (tx) => cancelOrder(tx, org.context, orderId, 'x'));

    const quotation = await owner.quotation.findUniqueOrThrow({
      where: { id: before.quotationId },
    });
    // The quotation is the record of what the customer accepted. Cancelling an order does not
    // unmake that.
    expect(quotation.status).toBe('ACCEPTED');
  });

  it('is audited', async () => {
    await withTenant(org.organizationId, (tx) => cancelOrder(tx, org.context, orderId, 'x'));
    const actions = (await owner.auditEvent.findMany({ where: { entityId: orderId } })).map(
      (event) => event.action,
    );
    expect(actions).toContain('order.cancelled');
    expect(actions).toContain('order.stock_released');
  });

  it('rolls back the release together with its audit row', async () => {
    await expect(
      withTenant(org.organizationId, async (tx) => {
        const cancelled = await cancelOrder(tx, org.context, orderId, 'x');
        expect(cancelled.ok).toBe(true);
        throw new Error('simulated failure after cancelling');
      }),
    ).rejects.toThrow('simulated failure');

    const order = await owner.salesOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('OPEN');
    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.reservedStock).toBe(500);
    await assertReservedAggregateMatches(org.organizationId);
  });
});

describe('competing for the same stock', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
  });

  /**
   * Every setup step below runs **sequentially and to completion** before any conversion starts.
   *
   * The first version of these tests built the quotations inside the same `Promise.all` as the
   * conversions, and deadlocked — on the catalogue seed and the Phase 2 parse, not on the
   * reservation path. That measured the fixture rather than the thing under test. The whole
   * point of a concurrency test is that exactly one operation is concurrent.
   */
  async function acceptedQuotations(
    specs: { message: string; companyName: string }[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const spec of specs) {
      const quotation = await sentQuotation(org.organizationId, org.context, {
        accept: true,
        message: spec.message,
        companyName: spec.companyName,
      });
      ids.push(quotation.quotationId);
    }
    return ids;
  }

  /** Sets exact stock levels after setup, so the race starts from a known position. */
  async function setStock(levels: Record<string, number>): Promise<void> {
    for (const [sku, availableStock] of Object.entries(levels)) {
      await owner.product.updateMany({
        where: { organizationId: org.organizationId, sku },
        data: { availableStock, reservedStock: 0 },
      });
    }
  }

  /** The invariants that must hold however the transactions interleaved. */
  async function assertCoherent(): Promise<void> {
    const products = await owner.product.findMany({
      where: { organizationId: org.organizationId },
    });

    for (const product of products) {
      const active = await owner.stockReservation.aggregate({
        where: { organizationId: org.organizationId, productId: product.id, status: 'ACTIVE' },
        _sum: { quantity: true },
      });
      const activeTotal = active._sum.quantity ?? 0;

      // The aggregate is a cache of the ACTIVE rows and must agree with them exactly.
      expect(product.reservedStock, `${product.sku}: aggregate drifted`).toBe(activeTotal);
      // Nothing may be promised beyond what is on hand.
      expect(activeTotal, `${product.sku}: oversubscribed`).toBeLessThanOrEqual(
        product.availableStock,
      );
      expect(product.reservedStock).toBeGreaterThanOrEqual(0);
    }

    // Every ACTIVE reservation belongs to an order that is still open, and every open order owns
    // reservations for each of its lines. A half-created order would show up here.
    const orders = await owner.salesOrder.findMany({
      where: { organizationId: org.organizationId },
      include: { items: true, reservations: true },
    });

    for (const order of orders) {
      expect(order.items.length, `${order.orderNumber} has no lines`).toBeGreaterThan(0);

      if (order.status === 'OPEN') {
        expect(
          order.reservations.filter((reservation) => reservation.status === 'ACTIVE'),
          `${order.orderNumber}: an open order must own an active reservation per line`,
        ).toHaveLength(order.items.length);
      } else {
        expect(
          order.reservations.every((reservation) => reservation.status !== 'ACTIVE'),
          `${order.orderNumber}: a cancelled order still holds stock`,
        ).toBe(true);
      }

      // The audit trail exists for every order that exists.
      const events = await owner.auditEvent.findMany({ where: { entityId: order.id } });
      expect(events.map((event) => event.action)).toContain('order.created');
    }

    // No reservation belongs to an order that does not exist.
    const orphans = await owner.stockReservation.count({
      where: {
        organizationId: org.organizationId,
        salesOrderId: { notIn: orders.map((order) => order.id) },
      },
    });
    expect(orphans, 'reservation rows survived without an order').toBe(0);
  }

  it('never oversubscribes when two orders want the same product', async () => {
    // The pinned regression case, kept because it is the easiest to reason about.
    // 100 free; two orders want 70 each. Exactly one may win.
    const [first, second] = await acceptedQuotations([
      { message: '70 bags OPC cement', companyName: 'First Customer' },
      { message: '70 bags OPC cement', companyName: 'Second Customer' },
    ]);
    await setStock({ 'CEM-OPC-50': 100 });

    const results = await Promise.allSettled([
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId: first! }),
      ),
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId: second! }),
      ),
    ]);

    // Both transactions terminated cleanly — neither was killed by the deadlock detector.
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const outcomes = results.map((result) =>
      result.status === 'fulfilled' ? result.value : null,
    );
    expect(outcomes.filter((outcome) => outcome?.ok).length).toBe(1);

    // The loser fails with a structured refusal, not an exception.
    const loser = outcomes.find((outcome) => outcome && !outcome.ok);
    expect(loser && !loser.ok && loser.error.code).toBe('INSUFFICIENT_STOCK');

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.reservedStock).toBe(70);
    expect(await owner.salesOrder.count()).toBe(1);

    await assertCoherent();
  });

  it('lets both through when there is enough for both', async () => {
    const [first, second] = await acceptedQuotations([
      { message: '70 bags OPC cement', companyName: 'First Customer' },
      { message: '70 bags OPC cement', companyName: 'Second Customer' },
    ]);
    await setStock({ 'CEM-OPC-50': 200 });

    await Promise.allSettled([
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId: first! }),
      ),
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId: second! }),
      ),
    ]);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.reservedStock).toBe(140);
    expect(await owner.salesOrder.count()).toBe(2);
    await assertCoherent();
  });

  it('holds the invariant when two orders overlap on several products', async () => {
    /*
     * The lock-ordering case, from the brief:
     *
     *   Cement 100 available, Rebar 100 available
     *   Quote 1 wants cement 70, rebar 20
     *   Quote 2 wants cement 40, rebar 70
     *
     * Combined, cement is oversubscribed (110) while rebar is not (90). Whichever transaction
     * goes second must fail in full, taking its rebar reservation down with it — a partial
     * order holding rebar but not cement would be exactly the corruption all-or-nothing exists
     * to prevent.
     *
     * The two quotations also list the products in opposite orders, which is what would deadlock
     * if the code locked in quotation-line order rather than by sorted product id.
     */
    const [first, second] = await acceptedQuotations([
      { message: '70 bags OPC cement, 20 pcs 12mm rebar', companyName: 'Overlap One' },
      { message: '70 pcs 12mm rebar, 40 bags OPC cement', companyName: 'Overlap Two' },
    ]);
    await setStock({ 'CEM-OPC-50': 100, 'RB-12': 100 });

    const results = await Promise.allSettled([
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId: first! }),
      ),
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId: second! }),
      ),
    ]);

    expect(
      results.every((result) => result.status === 'fulfilled'),
      'a transaction was aborted — check the lock graph, not the fixture',
    ).toBe(true);

    const outcomes = results.map((result) =>
      result.status === 'fulfilled' ? result.value : null,
    );
    const winners = outcomes.filter((outcome) => outcome?.ok);
    const losers = outcomes.filter((outcome) => outcome && !outcome.ok);

    // Cement cannot satisfy both, so exactly one conversion may succeed.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0] && !losers[0].ok && losers[0].error.code).toBe('INSUFFICIENT_STOCK');

    // The failed conversion left nothing behind: no order, no rebar reservation.
    expect(await owner.salesOrder.count()).toBe(1);
    const reservations = await owner.stockReservation.findMany({
      where: { organizationId: org.organizationId },
    });
    expect(reservations).toHaveLength(2);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    const rebar = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'RB-12' },
    });

    // Whichever won, the pair must be one of the two coherent outcomes.
    expect([
      { cement: 70, rebar: 20 },
      { cement: 40, rebar: 70 },
    ]).toContainEqual({ cement: cement.reservedStock, rebar: rebar.reservedStock });

    await assertCoherent();
  });

  it('does not deadlock with four orders contending on the same two products', async () => {
    // Enough stock for everyone, so nothing fails for business reasons and any failure would be
    // a lock-graph problem. The line orders alternate deliberately.
    const ids = await acceptedQuotations(
      [0, 1, 2, 3].map((index) => ({
        message:
          index % 2 === 0
            ? '10 bags OPC cement, 10 pcs 12mm rebar'
            : '10 pcs 12mm rebar, 10 bags OPC cement',
        companyName: `Contending Customer ${index}`,
      })),
    );
    await setStock({ 'CEM-OPC-50': 500, 'RB-12': 500 });

    const results = await Promise.allSettled(
      ids.map((quotationId) =>
        withTenant(org.organizationId, (tx) =>
          createFromQuotation(tx, org.context, { quotationId }),
        ),
      ),
    );

    expect(
      results.every((result) => result.status === 'fulfilled'),
      'a transaction was aborted — deterministic lock ordering should prevent this',
    ).toBe(true);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value.ok)).toHaveLength(4);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.reservedStock).toBe(40);
    await assertCoherent();
  });

  it('does not leave an impossible state when a cancellation races a conversion', async () => {
    const [first, second] = await acceptedQuotations([
      { message: '60 bags OPC cement', companyName: 'First Customer' },
      { message: '60 bags OPC cement', companyName: 'Second Customer' },
    ]);
    await setStock({ 'CEM-OPC-50': 100 });

    const created = await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId: first! }),
    );
    if (!created.ok) throw new Error('setup failed');

    // The cancellation frees 60; the conversion wants 60. Either order is legitimate.
    const results = await Promise.allSettled([
      withTenant(org.organizationId, (tx) => cancelOrder(tx, org.context, created.value.id, 'x')),
      withTenant(org.organizationId, (tx) =>
        createFromQuotation(tx, org.context, { quotationId: second! }),
      ),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    await assertCoherent();
  });
});

describe('metrics', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
  });

  it('counts follow-ups and their outcomes', async () => {
    const { quotationId } = await sentQuotation(org.organizationId, org.context);
    const [followUp] = await owner.quotationFollowUp.findMany({ where: { quotationId } });
    await withTenant(org.organizationId, (tx) =>
      completeFollowUp(tx, org.context, followUp!.id, { outcome: 'CUSTOMER_CONSIDERING' }),
    );

    const metrics = await withTenant(org.organizationId, (tx) => followUpMetrics(tx));
    expect(metrics.completedFollowUps).toBe(1);
    expect(metrics.outcomeDistribution.CUSTOMER_CONSIDERING).toBe(1);
    expect(metrics.completionRate).toBe(1);
  });

  it('counts conversion and the sales lost to stock', async () => {
    const accepted = await sentQuotation(org.organizationId, org.context, { accept: true });
    await owner.product.updateMany({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      data: { availableStock: 1 },
    });
    await withTenant(org.organizationId, (tx) =>
      createFromQuotation(tx, org.context, { quotationId: accepted.quotationId }),
    );

    const metrics = await withTenant(org.organizationId, (tx) => conversionMetrics(tx));
    expect(metrics.accepted).toBe(1);
    expect(metrics.stockRefusals).toBe(1);
    expect(metrics.acceptedWithoutOrder).toBe(1);
  });
});
