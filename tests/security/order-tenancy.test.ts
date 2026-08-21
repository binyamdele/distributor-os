import { beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { recordAcceptance, recordRejection } from '@/modules/quotations';
import { completeFollowUp, followUpQueue, followUpsFor, snoozeFollowUp } from '@/modules/followups';
import { cancelOrder, createFromQuotation, getOrder, listOrders } from '@/modules/orders';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { sentQuotation } from '../support/order-fixtures';

/**
 * Cross-tenant safety for follow-ups, acceptance, orders and reservations — tested with
 * **planted foreign identifiers**, not by navigating the UI.
 *
 * Navigation cannot produce a foreign id, so a test that only navigates proves nothing about the
 * boundary. Every case below hands the server an id that genuinely belongs to another
 * organization, which is the shape a crafted form post or a guessed URL would take.
 *
 * The reservation cases matter most: a leak here would not just expose data, it would take
 * another distributor's stock out of their reach.
 */
describe('Phase 4 objects cannot cross an organization boundary', () => {
  let addis: Awaited<ReturnType<typeof seedOrg>>;
  let rift: Awaited<ReturnType<typeof seedOrg>>;

  let riftQuotationId: string;
  let riftAcceptedQuotationId: string;
  let riftFollowUpId: string;
  let riftOrderId: string;
  let riftProductId: string;

  let addisAcceptedQuotationId: string;

  beforeAll(async () => {
    await resetDatabase();
    addis = await seedOrg('Addis Build Supply', 'SALES_MANAGER');
    rift = await seedOrg('Rift Valley Trading', 'SALES_MANAGER');

    // Rift: one sent quotation with an open follow-up, and one accepted quotation with an order.
    riftQuotationId = (
      await sentQuotation(rift.organizationId, rift.context, { companyName: 'Adama Roads' })
    ).quotationId;
    riftFollowUpId = (
      await owner.quotationFollowUp.findFirstOrThrow({ where: { quotationId: riftQuotationId } })
    ).id;

    riftAcceptedQuotationId = (
      await sentQuotation(rift.organizationId, rift.context, {
        companyName: 'Adama Bridges',
        accept: true,
        message: '10 bags OPC cement',
      })
    ).quotationId;

    const riftOrder = await withTenant(rift.organizationId, (tx) =>
      createFromQuotation(tx, rift.context, { quotationId: riftAcceptedQuotationId }),
    );
    if (!riftOrder.ok) throw new Error('rift order setup failed');
    riftOrderId = riftOrder.value.id;

    riftProductId = (
      await owner.product.findFirstOrThrow({
        where: { organizationId: rift.organizationId, sku: 'CEM-OPC-50' },
      })
    ).id;

    // Addis: an accepted quotation of its own, so foreign-id attempts have a real target.
    addisAcceptedQuotationId = (
      await sentQuotation(addis.organizationId, addis.context, {
        companyName: 'ABC Construction PLC',
        accept: true,
      })
    ).quotationId;
  });

  describe('follow-ups', () => {
    it('are not listed across organizations', async () => {
      const later = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const mine = await withTenant(addis.organizationId, (tx) =>
        followUpQueue(tx, { now: later }),
      );
      expect(mine.every((row) => row.quotationId !== riftQuotationId)).toBe(true);
    });

    it('cannot be read for another organization’s quotation', async () => {
      const rows = await withTenant(addis.organizationId, (tx) =>
        followUpsFor(tx, riftQuotationId),
      );
      expect(rows).toEqual([]);
    });

    it('cannot be completed with a planted id', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        completeFollowUp(tx, addis.context, riftFollowUpId, { outcome: 'NO_RESPONSE' }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

      const untouched = await owner.quotationFollowUp.findUniqueOrThrow({
        where: { id: riftFollowUpId },
      });
      expect(untouched.status).toBe('DUE');
    });

    it('cannot be snoozed with a planted id', async () => {
      const before = await owner.quotationFollowUp.findUniqueOrThrow({
        where: { id: riftFollowUpId },
      });
      const result = await withTenant(addis.organizationId, (tx) =>
        snoozeFollowUp(tx, addis.context, riftFollowUpId, { days: 7 }),
      );
      expect(result.ok).toBe(false);

      const after = await owner.quotationFollowUp.findUniqueOrThrow({
        where: { id: riftFollowUpId },
      });
      expect(after.dueAt.toISOString()).toBe(before.dueAt.toISOString());
    });
  });

  describe('acceptance and rejection', () => {
    it('cannot be recorded on another organization’s quotation', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        recordAcceptance(tx, addis.context, riftQuotationId, { source: 'PHONE' }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

      const untouched = await owner.quotation.findUniqueOrThrow({ where: { id: riftQuotationId } });
      expect(untouched.status).toBe('SENT');
      expect(untouched.acceptedAt).toBeNull();
    });

    it('cannot reject another organization’s quotation', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        recordRejection(tx, addis.context, riftQuotationId, { reason: 'PRICE' }),
      );
      expect(result.ok).toBe(false);
      expect(
        (await owner.quotation.findUniqueOrThrow({ where: { id: riftQuotationId } })).status,
      ).toBe('SENT');
    });
  });

  describe('order creation', () => {
    it('cannot convert another organization’s accepted quotation', async () => {
      const before = await owner.salesOrder.count({ where: { organizationId: rift.organizationId } });

      const result = await withTenant(addis.organizationId, (tx) =>
        createFromQuotation(tx, addis.context, { quotationId: riftAcceptedQuotationId }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

      expect(
        await owner.salesOrder.count({ where: { organizationId: rift.organizationId } }),
      ).toBe(before);
    });

    it('cannot reserve another organization’s stock', async () => {
      // The case that matters most: a leak here removes a competitor's goods from their reach.
      const before = await owner.product.findUniqueOrThrow({ where: { id: riftProductId } });

      await withTenant(addis.organizationId, (tx) =>
        createFromQuotation(tx, addis.context, { quotationId: riftAcceptedQuotationId }),
      );

      const after = await owner.product.findUniqueOrThrow({ where: { id: riftProductId } });
      expect(after.reservedStock).toBe(before.reservedStock);
      expect(after.availableStock).toBe(before.availableStock);

      // And no reservation row was created against it by the wrong tenant.
      const foreign = await owner.stockReservation.count({
        where: { productId: riftProductId, organizationId: addis.organizationId },
      });
      expect(foreign).toBe(0);
    });
  });

  describe('orders and reservations', () => {
    it('cannot read another organization’s order', async () => {
      const result = await withTenant(addis.organizationId, (tx) => getOrder(tx, riftOrderId));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
    });

    it('lists only its own orders', async () => {
      const rows = await withTenant(addis.organizationId, (tx) => listOrders(tx));
      expect(rows.every((row) => row.id !== riftOrderId)).toBe(true);
    });

    it('cannot cancel another organization’s order', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        cancelOrder(tx, addis.context, riftOrderId, 'not mine to cancel'),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

      const order = await owner.salesOrder.findUniqueOrThrow({ where: { id: riftOrderId } });
      expect(order.status).toBe('OPEN');
      expect(order.cancelledAt).toBeNull();
    });

    it('cannot release another organization’s reservations by cancelling', async () => {
      const before = await owner.product.findUniqueOrThrow({ where: { id: riftProductId } });
      expect(before.reservedStock).toBeGreaterThan(0);

      await withTenant(addis.organizationId, (tx) =>
        cancelOrder(tx, addis.context, riftOrderId, 'attempt'),
      );

      const after = await owner.product.findUniqueOrThrow({ where: { id: riftProductId } });
      expect(after.reservedStock).toBe(before.reservedStock);

      const active = await owner.stockReservation.count({
        where: { salesOrderId: riftOrderId, status: 'ACTIVE' },
      });
      expect(active).toBeGreaterThan(0);
    });

    it('cannot see another organization’s reservation rows', async () => {
      const mine = await withTenant(addis.organizationId, (tx) => tx.stockReservation.count());
      const theirs = await owner.stockReservation.count({
        where: { organizationId: rift.organizationId },
      });
      expect(theirs).toBeGreaterThan(0);

      const all = await owner.stockReservation.count();
      expect(mine).toBeLessThan(all);
      expect(mine).toBe(all - theirs);
    });
  });

  describe('numbering', () => {
    it('gives each organization its own SO-000001', async () => {
      const mine = await withTenant(addis.organizationId, (tx) =>
        createFromQuotation(tx, addis.context, { quotationId: addisAcceptedQuotationId }),
      );
      expect(mine.ok).toBe(true);
      if (!mine.ok) return;

      const theirs = await owner.salesOrder.findUniqueOrThrow({ where: { id: riftOrderId } });
      expect(mine.value.orderNumber).toBe('SO-000001');
      expect(theirs.orderNumber).toBe('SO-000001');
    });
  });

  describe('row-level security underneath', () => {
    it('hides orders from an unscoped count', async () => {
      const rows = await withTenant(addis.organizationId, (tx) =>
        tx.$queryRawUnsafe<{ count: bigint }[]>(
          'SELECT count(*)::bigint AS count FROM sales_orders',
        ),
      );
      const total = await owner.salesOrder.count();
      expect(Number(rows[0]?.count)).toBeLessThan(total);
    });

    it('refuses to delete a reservation record', async () => {
      // Append-only: releasing sets a status, it never removes the evidence.
      await expect(
        withTenant(rift.organizationId, (tx) => tx.stockReservation.deleteMany({})),
      ).rejects.toThrow();
    });
  });
});
