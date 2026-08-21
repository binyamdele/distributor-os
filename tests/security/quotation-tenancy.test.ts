import { beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import {
  addLine,
  approve,
  createFromInquiry,
  getQuotation,
  listQuotations,
  markSent,
  reject,
  removeLine,
  setCustomer,
  setDeliveryFee,
  setLineDiscount,
  setLineQuantity,
  submitForApproval,
} from '@/modules/quotations';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { readyInquiry } from '../support/quotation-fixtures';

/**
 * Cross-tenant safety for quotations, tested with **malicious direct identifiers** rather than
 * by navigating the UI.
 *
 * Normal navigation can never produce a foreign id, so a test that only navigates proves
 * nothing about the boundary. Every case below hands the server an id that genuinely belongs to
 * another organization — the shape a crafted form post or a guessed URL would take — and
 * requires it to fail closed.
 */
describe('quotations cannot cross an organization boundary', () => {
  let addis: Awaited<ReturnType<typeof seedOrg>>;
  let rift: Awaited<ReturnType<typeof seedOrg>>;

  let riftQuotationId: string;
  let riftLineId: string;
  let riftProductId: string;
  let riftCustomerId: string;
  let riftInquiryId: string;

  let addisInquiryId: string;
  let addisQuotationId: string;

  beforeAll(async () => {
    await resetDatabase();
    addis = await seedOrg('Addis Build Supply', 'SALESPERSON');
    rift = await seedOrg('Rift Valley Trading', 'SALES_MANAGER');

    const addisReady = await readyInquiry(addis.organizationId, addis.context, {
      companyName: 'ABC Construction PLC',
    });
    addisInquiryId = addisReady.inquiryId;

    const riftReady = await readyInquiry(rift.organizationId, rift.context, {
      companyName: 'Adama Roads Authority',
    });
    riftInquiryId = riftReady.inquiryId;
    riftCustomerId = riftReady.customerId;

    const riftQuote = await withTenant(rift.organizationId, (tx) =>
      createFromInquiry(tx, rift.context, { inquiryId: riftInquiryId }),
    );
    if (!riftQuote.ok) throw new Error('rift quotation setup failed');
    riftQuotationId = riftQuote.value.id;

    const line = await owner.quotationItem.findFirstOrThrow({
      where: { quotationId: riftQuotationId },
    });
    riftLineId = line.id;

    riftProductId = (
      await owner.product.findFirstOrThrow({
        where: { organizationId: rift.organizationId, sku: 'RB-12' },
      })
    ).id;

    const addisQuote = await withTenant(addis.organizationId, (tx) =>
      createFromInquiry(tx, addis.context, { inquiryId: addisInquiryId }),
    );
    if (!addisQuote.ok) throw new Error('addis quotation setup failed');
    addisQuotationId = addisQuote.value.id;
  });

  describe('reading', () => {
    it('cannot read another organization’s quotation by id', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        getQuotation(tx, riftQuotationId),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
    });

    it('lists only its own quotations', async () => {
      const rows = await withTenant(addis.organizationId, (tx) => listQuotations(tx));
      expect(rows.map((row) => row.id)).toEqual([addisQuotationId]);
    });
  });

  describe('drafting', () => {
    it('cannot draft from another organization’s inquiry', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        createFromInquiry(tx, addis.context, { inquiryId: riftInquiryId }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('editing with a planted identifier', () => {
    it('cannot change a quantity on another organization’s line', async () => {
      const before = await owner.quotationItem.findUniqueOrThrow({ where: { id: riftLineId } });

      const result = await withTenant(addis.organizationId, (tx) =>
        setLineQuantity(tx, addis.context, riftQuotationId, riftLineId, { quantity: 1 }),
      );
      expect(result.ok).toBe(false);

      const after = await owner.quotationItem.findUniqueOrThrow({ where: { id: riftLineId } });
      expect(after.quantity).toBe(before.quantity);
    });

    it('cannot discount another organization’s line', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        setLineDiscount(tx, addis.context, riftQuotationId, riftLineId, { discountBp: 9000 }),
      );
      expect(result.ok).toBe(false);
      const after = await owner.quotationItem.findUniqueOrThrow({ where: { id: riftLineId } });
      expect(after.discountBp).toBe(0);
    });

    it('cannot remove another organization’s line', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        removeLine(tx, addis.context, riftQuotationId, riftLineId),
      );
      expect(result.ok).toBe(false);
      expect(await owner.quotationItem.count({ where: { id: riftLineId } })).toBe(1);
    });

    it('cannot set a delivery fee on another organization’s quotation', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        setDeliveryFee(tx, addis.context, riftQuotationId, 999_999n),
      );
      expect(result.ok).toBe(false);
      const after = await owner.quotation.findUniqueOrThrow({ where: { id: riftQuotationId } });
      expect(after.deliveryFeeMinor).toBe(0n);
    });

    it('cannot price a foreign product into its own quotation', async () => {
      // The most valuable case: a real quotation in the right organization, with a product id
      // from the wrong one. It must be refused, not silently priced from the other catalogue.
      const result = await withTenant(addis.organizationId, (tx) =>
        addLine(tx, addis.context, addisQuotationId, { productId: riftProductId, quantity: 5 }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

      const lines = await owner.quotationItem.findMany({
        where: { quotationId: addisQuotationId },
      });
      expect(lines.every((line) => line.productId !== riftProductId)).toBe(true);
    });

    it('cannot attach a foreign customer to its own quotation', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        setCustomer(tx, addis.context, addisQuotationId, riftCustomerId),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

      const after = await owner.quotation.findUniqueOrThrow({ where: { id: addisQuotationId } });
      expect(after.customerId).not.toBe(riftCustomerId);
    });
  });

  describe('deciding', () => {
    it('cannot submit another organization’s quotation', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        submitForApproval(tx, addis.context, riftQuotationId),
      );
      expect(result.ok).toBe(false);
      const after = await owner.quotation.findUniqueOrThrow({ where: { id: riftQuotationId } });
      expect(after.status).toBe('DRAFT');
    });

    it('cannot approve another organization’s quotation', async () => {
      await withTenant(rift.organizationId, (tx) =>
        submitForApproval(tx, rift.context, riftQuotationId),
      );

      const result = await withTenant(addis.organizationId, (tx) =>
        approve(tx, addis.context, riftQuotationId),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

      const after = await owner.quotation.findUniqueOrThrow({ where: { id: riftQuotationId } });
      expect(after.status).toBe('PENDING_APPROVAL');
      expect(after.approvedById).toBeNull();
      expect(await owner.quotationApproval.count({ where: { quotationId: riftQuotationId } })).toBe(0);
    });

    it('cannot reject another organization’s quotation', async () => {
      const result = await withTenant(addis.organizationId, (tx) =>
        reject(tx, addis.context, riftQuotationId, 'not mine to reject'),
      );
      expect(result.ok).toBe(false);
    });

    it('cannot mark another organization’s quotation as sent', async () => {
      await withTenant(rift.organizationId, (tx) => approve(tx, rift.context, riftQuotationId));

      const result = await withTenant(addis.organizationId, (tx) =>
        markSent(tx, addis.context, riftQuotationId),
      );
      expect(result.ok).toBe(false);

      const after = await owner.quotation.findUniqueOrThrow({ where: { id: riftQuotationId } });
      expect(after.status).toBe('APPROVED');
      expect(after.sentAt).toBeNull();
    });
  });

  describe('the approval hash', () => {
    it('cannot be replayed from one organization onto another', async () => {
      // Both organizations were seeded with the same catalogue and the same message, so their
      // quotations carry identical commercial figures. Only organizationId differs — and it is
      // in the payload precisely so that the hashes cannot coincide.
      const addisQuote = await owner.quotation.findUniqueOrThrow({
        where: { id: addisQuotationId },
      });
      const riftQuote = await owner.quotation.findUniqueOrThrow({ where: { id: riftQuotationId } });

      expect(addisQuote.subtotalMinor).toBe(riftQuote.subtotalMinor);
      expect(addisQuote.currentPayloadHash).not.toBe(riftQuote.currentPayloadHash);
    });
  });

  describe('the number sequence', () => {
    it('is not shared between organizations', async () => {
      const addisSequence = await owner.numberSequence.findFirstOrThrow({
        where: { organizationId: addis.organizationId, kind: 'QUOTATION' },
      });
      const riftSequence = await owner.numberSequence.findFirstOrThrow({
        where: { organizationId: rift.organizationId, kind: 'QUOTATION' },
      });

      expect(addisSequence.id).not.toBe(riftSequence.id);
      // Each organization issued exactly one quotation, so each sequence has advanced once.
      expect(addisSequence.nextValue).toBe(2n);
      expect(riftSequence.nextValue).toBe(2n);
    });

    it('gives both organizations their own Q-000001', async () => {
      const addisQuote = await owner.quotation.findUniqueOrThrow({
        where: { id: addisQuotationId },
      });
      const riftQuote = await owner.quotation.findUniqueOrThrow({ where: { id: riftQuotationId } });
      expect(addisQuote.quotationNumber).toBe('Q-000001');
      expect(riftQuote.quotationNumber).toBe('Q-000001');
    });
  });

  describe('row-level security underneath', () => {
    it('hides quotations from an unscoped query', async () => {
      const rows = await withTenant(addis.organizationId, (tx) =>
        tx.$queryRawUnsafe<{ count: bigint }[]>('SELECT count(*)::bigint AS count FROM quotations'),
      );
      const total = await owner.quotation.count();
      expect(total).toBe(2);
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it('refuses an update to an approval record', async () => {
      // Append-only: evidence of who authorised what must not be rewritable.
      await expect(
        withTenant(rift.organizationId, (tx) =>
          tx.quotationApproval.updateMany({ data: { decision: 'REJECTED' } }),
        ),
      ).rejects.toThrow();
    });
  });
});
