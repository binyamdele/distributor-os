import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import {
  addLine,
  approve,
  createFromInquiry,
  getQuotation,
  markSent,
  reject,
  removeLine,
  setDeliveryFee,
  setLineDiscount,
  setLineQuantity,
  setNotes,
  setPaymentTerms,
  submitForApproval,
} from '@/modules/quotations';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { readyInquiry } from '../support/quotation-fixtures';

describe('quotations', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let manager: Awaited<ReturnType<typeof seedOrg>>['context'];
  let inquiryId: string;
  let customerId: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALESPERSON');
    await owner.organizationSettings.upsert({
      where: { organizationId: org.organizationId },
      update: {},
      create: { organizationId: org.organizationId },
    });
    manager = { ...org.context, role: 'SALES_MANAGER' };
    ({ inquiryId, customerId } = await readyInquiry(org.organizationId, org.context));
  });

  async function draft(paymentType: 'CASH' | 'CREDIT' = 'CASH', paymentTermsDays = 0) {
    const result = await withTenant(org.organizationId, (tx) =>
      createFromInquiry(tx, org.context, { inquiryId, paymentType, paymentTermsDays }),
    );
    if (!result.ok) throw new Error(`draft failed: ${result.error.message}`);
    return result.value;
  }

  async function view(quotationId: string) {
    const result = await withTenant(org.organizationId, (tx) => getQuotation(tx, quotationId));
    if (!result.ok) throw new Error('quotation not readable');
    return result.value;
  }

  describe('drafting from a reviewed inquiry', () => {
    it('builds lines from the confirmed products only', async () => {
      const { id, quotationNumber } = await draft();
      expect(quotationNumber).toBe('Q-000001');

      const quotation = await view(id);
      expect(quotation.status).toBe('DRAFT');
      expect(quotation.lines.map((line) => line.sku)).toEqual([
        'CEM-OPC-50',
        'RB-12',
        'RB-10',
      ]);
      expect(quotation.customer.id).toBe(customerId);
    });

    it('snapshots the commercial facts onto each line', async () => {
      const { id } = await draft();
      const quotation = await view(id);
      const [cement] = quotation.lines;

      expect(cement!.description).toBe('OPC Cement 50kg');
      expect(cement!.unit).toBe('bag');
      expect(cement!.listUnitPriceMinor).toBe(125_000n);
      expect(cement!.quotedUnitPriceMinor).toBe(125_000n);
      expect(cement!.taxRateBp).toBe(1500);
      expect(cement!.quantity).toBe(500);
    });

    it('computes totals that reconcile', async () => {
      const { id } = await draft();
      const quotation = await view(id);

      // 500 × 1,250.00 + 80 × 1,420.00 + 50 × 985.00 = 787,850.00
      expect(quotation.subtotalMinor).toBe(787_850_00n);
      expect(quotation.grandTotalMinor).toBe(
        quotation.subtotalMinor -
          quotation.discountTotalMinor +
          quotation.taxTotalMinor +
          quotation.deliveryFeeMinor,
      );
    });

    it('refuses an inquiry that is not ready', async () => {
      await owner.inquiry.update({ where: { id: inquiryId }, data: { status: 'NEEDS_REVIEW' } });
      const result = await withTenant(org.organizationId, (tx) =>
        createFromInquiry(tx, org.context, { inquiryId }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('refuses to build a line from an unconfirmed match', async () => {
      // Belt and braces behind the readiness gate: never quote the machine's opinion.
      const item = await owner.inquiryItemProposal.findFirstOrThrow({ where: { inquiryId } });
      await owner.inquiryItemProposal.update({
        where: { id: item.id },
        data: { matchedProductId: null, reviewStatus: 'SUGGESTED' },
      });

      const result = await withTenant(org.organizationId, (tx) =>
        createFromInquiry(tx, org.context, { inquiryId }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.message).toMatch(/confirmed product/i);
    });

    it('downgrades credit to cash for an ineligible customer', async () => {
      await owner.customer.update({
        where: { id: customerId },
        data: { creditStatus: 'SUSPENDED' },
      });
      const { id } = await draft('CREDIT', 30);
      const quotation = await view(id);
      expect(quotation.paymentType).toBe('CASH');
      expect(quotation.paymentTermsDays).toBe(0);
    });

    it('records the draft in the audit log', async () => {
      const { id } = await draft();
      const events = await owner.auditEvent.findMany({ where: { entityId: id } });
      expect(events.map((e) => e.action)).toContain('quotation.created');
    });
  });

  describe('the price snapshot', () => {
    it('does not move when the catalogue moves', async () => {
      const { id } = await draft();
      const before = await view(id);
      expect(before.lines[0]!.listUnitPriceMinor).toBe(125_000n);
      const totalBefore = before.grandTotalMinor;

      // The distributor reprices cement overnight.
      await owner.product.updateMany({
        where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
        data: { sellingPriceMinor: 151_000n },
      });

      const after = await view(id);
      expect(after.lines[0]!.listUnitPriceMinor).toBe(125_000n);
      expect(after.lines[0]!.quotedUnitPriceMinor).toBe(125_000n);
      expect(after.grandTotalMinor).toBe(totalBefore);
      // The live price is shown beside it as context, flagged as moved.
      expect(after.lines[0]!.currentListPriceMinor).toBe(151_000n);
      expect(after.lines[0]!.priceHasMoved).toBe(true);
    });

    it('survives the product being renamed', async () => {
      const { id } = await draft();
      await owner.product.updateMany({
        where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
        data: { name: 'Something Else Entirely' },
      });

      const quotation = await view(id);
      expect(quotation.lines[0]!.description).toBe('OPC Cement 50kg');
    });

    it('survives the product being deleted', async () => {
      const { id } = await draft();
      await owner.productAlias.deleteMany({ where: { organizationId: org.organizationId } });
      await owner.inquiryItemProposal.deleteMany({ where: { organizationId: org.organizationId } });
      await owner.product.deleteMany({
        where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      });

      const quotation = await view(id);
      expect(quotation.lines[0]!.description).toBe('OPC Cement 50kg');
      expect(quotation.lines[0]!.listUnitPriceMinor).toBe(125_000n);
      expect(quotation.lines[0]!.currentStock).toBeNull();
    });

    it('does not reserve or decrement stock', async () => {
      const stockBefore = await owner.product.findFirstOrThrow({
        where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
      });
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));

      const stockAfter = await owner.product.findFirstOrThrow({ where: { id: stockBefore.id } });
      expect(stockAfter.availableStock).toBe(stockBefore.availableStock);
      expect(stockAfter.reservedStock).toBe(stockBefore.reservedStock);
    });
  });

  describe('the approval workflow', () => {
    it('lets a salesperson approve an undiscounted quotation', async () => {
      const { id } = await draft();
      const submitted = await withTenant(org.organizationId, (tx) =>
        submitForApproval(tx, org.context, id),
      );
      expect(submitted.ok && submitted.value.level).toBe('SALESPERSON');

      const approved = await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));
      expect(approved.ok).toBe(true);

      const quotation = await view(id);
      expect(quotation.status).toBe('APPROVED');
      expect(quotation.approvalIsLive).toBe(true);
      expect(quotation.approvedPayloadHash).toBe(quotation.currentPayloadHash);
    });

    it('refuses a salesperson on a manager-level discount', async () => {
      const { id } = await draft();
      const quotation = await view(id);
      await withTenant(org.organizationId, (tx) =>
        setLineDiscount(tx, org.context, id, quotation.lines[0]!.id, { discountBp: 500 }),
      );
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));

      const attempt = await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));
      expect(attempt.ok).toBe(false);
      expect(attempt.ok === false && attempt.error.code).toBe('APPROVAL_REQUIRED');

      const managerAttempt = await withTenant(org.organizationId, (tx) => approve(tx, manager, id));
      expect(managerAttempt.ok).toBe(true);
      expect((await view(id)).status).toBe('APPROVED');
    });

    it('refuses to submit a blocked quotation', async () => {
      const { id } = await draft();
      const quotation = await view(id);
      await withTenant(org.organizationId, (tx) =>
        setLineDiscount(tx, org.context, id, quotation.lines[0]!.id, { discountBp: 4000 }),
      );

      const submitted = await withTenant(org.organizationId, (tx) =>
        submitForApproval(tx, org.context, id),
      );
      expect(submitted.ok).toBe(false);
      expect((await view(id)).status).toBe('DRAFT');
    });

    it('records who approved which exact payload', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));

      const quotation = await view(id);
      expect(quotation.approvals).toHaveLength(1);
      expect(quotation.approvals[0]).toMatchObject({
        decision: 'APPROVED',
        approverRole: 'SALESPERSON',
        requiredLevel: 'SALESPERSON',
        matchesCurrent: true,
      });
      expect(quotation.approvals[0]!.payloadHash).toBe(quotation.currentPayloadHash);
    });

    it('is idempotent when the same figures are approved twice', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));

      const second = await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));
      expect(second.ok).toBe(true);
      expect(second.ok && second.value.alreadyApproved).toBe(true);

      // One decision, not two.
      expect(await owner.quotationApproval.count({ where: { quotationId: id } })).toBe(1);
    });

    it('refuses an approval for figures the approver did not see', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));

      const attempt = await withTenant(org.organizationId, (tx) =>
        approve(tx, org.context, id, { expectedPayloadHash: 'a-hash-from-an-older-screen' }),
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.ok === false && attempt.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    });

    it('sends a rejection back to draft with a durable record', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      const rejected = await withTenant(org.organizationId, (tx) =>
        reject(tx, manager, id, 'Margin too thin for this customer'),
      );
      expect(rejected.ok).toBe(true);

      const quotation = await view(id);
      expect(quotation.status).toBe('DRAFT');
      expect(quotation.approvals[0]).toMatchObject({
        decision: 'REJECTED',
        reason: 'Margin too thin for this customer',
      });
    });
  });

  describe('approval invalidation', () => {
    async function approvedQuotation() {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));
      const quotation = await view(id);
      expect(quotation.approvalIsLive).toBe(true);
      return { id, hash: quotation.currentPayloadHash, lineId: quotation.lines[0]!.id };
    }

    const edits: [string, (id: string, lineId: string) => Promise<unknown>][] = [
      [
        'a quantity change',
        (id, lineId) =>
          withTenant(org.organizationId, (tx) =>
            setLineQuantity(tx, org.context, id, lineId, { quantity: 501 }),
          ),
      ],
      [
        'a discount change',
        (id, lineId) =>
          withTenant(org.organizationId, (tx) =>
            setLineDiscount(tx, org.context, id, lineId, { discountBp: 100 }),
          ),
      ],
      [
        'a delivery fee change',
        (id) =>
          withTenant(org.organizationId, (tx) => setDeliveryFee(tx, org.context, id, 450_000n)),
      ],
      [
        'a payment terms change',
        (id) =>
          withTenant(org.organizationId, (tx) =>
            setPaymentTerms(tx, org.context, id, { paymentType: 'CREDIT', paymentTermsDays: 30 }),
          ),
      ],
      [
        'removing a line',
        (id, lineId) => withTenant(org.organizationId, (tx) => removeLine(tx, org.context, id, lineId)),
      ],
    ];

    for (const [what, edit] of edits) {
      it(`is withdrawn by ${what}`, async () => {
        const { id, hash, lineId } = await approvedQuotation();
        await edit(id, lineId);

        const after = await view(id);
        expect(after.status).toBe('DRAFT');
        expect(after.approvalIsLive).toBe(false);
        expect(after.approvedPayloadHash).toBeNull();
        expect(after.currentPayloadHash).not.toBe(hash);
        // The history survives: who approved what, still answerable.
        expect(after.approvals[0]?.payloadHash).toBe(hash);
        expect(after.approvals[0]?.matchesCurrent).toBe(false);
      });
    }

    it('is withdrawn by adding a line', async () => {
      const { id, hash } = await approvedQuotation();
      const block = await owner.product.findFirstOrThrow({
        where: { organizationId: org.organizationId, sku: 'HB-20' },
      });

      await withTenant(org.organizationId, (tx) =>
        addLine(tx, org.context, id, { productId: block.id, quantity: 100 }),
      );

      const after = await view(id);
      expect(after.status).toBe('DRAFT');
      expect(after.currentPayloadHash).not.toBe(hash);
    });

    it('is withdrawn by a change of customer', async () => {
      const { id, hash } = await approvedQuotation();
      const other = await owner.customer.create({
        data: { organizationId: org.organizationId, companyName: 'Someone Else' },
      });

      const { setCustomer } = await import('@/modules/quotations');
      await withTenant(org.organizationId, (tx) => setCustomer(tx, org.context, id, other.id));

      const after = await view(id);
      expect(after.status).toBe('DRAFT');
      expect(after.currentPayloadHash).not.toBe(hash);
      expect(after.customer.id).toBe(other.id);
    });

    it('is not withdrawn by editing a note', async () => {
      // Notes change what the customer reads, not what the organization committed to.
      const { id, hash } = await approvedQuotation();
      await withTenant(org.organizationId, (tx) =>
        setNotes(tx, org.context, id, { customerNotes: 'Delivery before Friday please' }),
      );

      const after = await view(id);
      expect(after.status).toBe('APPROVED');
      expect(after.approvalIsLive).toBe(true);
      expect(after.currentPayloadHash).toBe(hash);
    });

    it('records the invalidation in the audit log', async () => {
      const { id, lineId } = await approvedQuotation();
      await withTenant(org.organizationId, (tx) =>
        setLineQuantity(tx, org.context, id, lineId, { quantity: 999 }),
      );

      const events = await owner.auditEvent.findMany({ where: { entityId: id } });
      expect(events.map((e) => e.action)).toContain('quotation.approval_invalidated');
    });

    it('drops credit terms the new customer is not entitled to', async () => {
      const { id } = await draft('CREDIT', 30);
      expect((await view(id)).paymentType).toBe('CREDIT');

      const cashOnly = await owner.customer.create({
        data: {
          organizationId: org.organizationId,
          companyName: 'Cash Only Co',
          creditStatus: 'CASH_ONLY',
        },
      });

      const { setCustomer } = await import('@/modules/quotations');
      await withTenant(org.organizationId, (tx) => setCustomer(tx, org.context, id, cashOnly.id));

      const after = await view(id);
      expect(after.paymentType).toBe('CASH');
      expect(after.paymentTermsDays).toBe(0);
    });
  });

  describe('marking sent', () => {
    it('refuses an unapproved quotation', async () => {
      const { id } = await draft();
      const attempt = await withTenant(org.organizationId, (tx) => markSent(tx, org.context, id));
      expect(attempt.ok).toBe(false);
      expect(attempt.ok === false && attempt.error.code).toBe('APPROVAL_REQUIRED');
      expect((await view(id)).status).toBe('DRAFT');
    });

    it('refuses a quotation whose approval was invalidated', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));

      const quotation = await view(id);
      await withTenant(org.organizationId, (tx) =>
        setLineQuantity(tx, org.context, id, quotation.lines[0]!.id, { quantity: 600 }),
      );

      const attempt = await withTenant(org.organizationId, (tx) => markSent(tx, org.context, id));
      expect(attempt.ok).toBe(false);
      expect((await view(id)).status).toBe('DRAFT');
    });

    it('refuses even if the status says approved but the figures moved underneath', async () => {
      // The server-side invariant, independent of the edit path having withdrawn the approval:
      // markSent re-derives the hash and compares.
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));

      // Tamper directly, bypassing every application code path.
      const line = await owner.quotationItem.findFirstOrThrow({ where: { quotationId: id } });
      await owner.quotationItem.update({ where: { id: line.id }, data: { quantity: 9_999 } });

      const attempt = await withTenant(org.organizationId, (tx) => markSent(tx, org.context, id));
      expect(attempt.ok).toBe(false);
      expect(attempt.ok === false && attempt.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
      expect((await view(id)).status).not.toBe('SENT');
    });

    it('records the send without transmitting anything', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));
      const sent = await withTenant(org.organizationId, (tx) => markSent(tx, org.context, id));
      expect(sent.ok).toBe(true);

      const quotation = await view(id);
      expect(quotation.status).toBe('SENT');
      expect(quotation.sentAt).not.toBeNull();

      const [event] = await owner.auditEvent.findMany({
        where: { action: 'quotation.marked_sent' },
      });
      expect((event?.newState as Record<string, unknown>).delivery).toBe('recorded_manually');
    });

    it('refuses to edit a sent quotation', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => markSent(tx, org.context, id));

      const quotation = await view(id);
      const attempt = await withTenant(org.organizationId, (tx) =>
        setLineQuantity(tx, org.context, id, quotation.lines[0]!.id, { quantity: 1 }),
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.ok === false && attempt.error.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('numbering', () => {
    it('starts at Q-000001 and increments', async () => {
      const first = await draft();
      expect(first.quotationNumber).toBe('Q-000001');

      // A second inquiry, so a second quotation is legitimate.
      const second = await readyInquiry(org.organizationId, org.context, {
        message: '20 bags cement',
        companyName: 'Second Customer',
        seedProducts: false,
      });
      const result = await withTenant(org.organizationId, (tx) =>
        createFromInquiry(tx, org.context, { inquiryId: second.inquiryId }),
      );
      expect(result.ok && result.value.quotationNumber).toBe('Q-000002');
    });

    it('never issues the same number twice under concurrency', async () => {
      const inquiries = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          readyInquiry(org.organizationId, org.context, {
            message: '10 bags cement',
            companyName: `Concurrent Customer ${index}`,
            seedProducts: false,
          }),
        ),
      );

      const results = await Promise.all(
        inquiries.map((inquiry) =>
          withTenant(org.organizationId, (tx) =>
            createFromInquiry(tx, org.context, { inquiryId: inquiry.inquiryId }),
          ),
        ),
      );

      const numbers = results.filter((r) => r.ok).map((r) => (r.ok ? r.value.quotationNumber : ''));
      expect(numbers).toHaveLength(8);
      expect(new Set(numbers).size).toBe(8);
    });

    it('numbers each organization independently', async () => {
      await draft();
      // seedOrg already creates the settings row.
      const other = await seedOrg('Rift Valley Trading', 'SALESPERSON');
      const otherInquiry = await readyInquiry(other.organizationId, other.context, {
        message: '10 bags cement',
        companyName: 'Their Customer',
      });

      const result = await withTenant(other.organizationId, (tx) =>
        createFromInquiry(tx, other.context, { inquiryId: otherInquiry.inquiryId }),
      );
      expect(result.ok && result.value.quotationNumber).toBe('Q-000001');
    });
  });

  describe('concurrency', () => {
    it('does not leave an approval attached to figures that changed', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      const quotation = await view(id);

      // Approve and edit at the same moment. The row lock serialises them; whichever order they
      // land in, the outcome must be coherent.
      await Promise.allSettled([
        withTenant(org.organizationId, (tx) => approve(tx, org.context, id)),
        withTenant(org.organizationId, (tx) =>
          setLineQuantity(tx, org.context, id, quotation.lines[0]!.id, { quantity: 777 }),
        ),
      ]);

      const after = await view(id);
      const line = await owner.quotationItem.findFirstOrThrow({
        where: { quotationId: id, skuSnapshot: 'CEM-OPC-50' },
      });

      // Whatever happened, the stored approval must describe the stored figures — or there must
      // be no live approval at all.
      if (after.approvalIsLive) {
        expect(after.approvedPayloadHash).toBe(after.currentPayloadHash);
      } else {
        expect(after.status === 'DRAFT' || after.status === 'PENDING_APPROVAL').toBe(true);
      }
      expect([500, 777]).toContain(line.quantity);
    });

    it('does not let concurrent sends both succeed on a stale payload', async () => {
      const { id } = await draft();
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));
      const quotation = await view(id);

      const [sent, edited] = await Promise.allSettled([
        withTenant(org.organizationId, (tx) => markSent(tx, org.context, id)),
        withTenant(org.organizationId, (tx) =>
          setLineQuantity(tx, org.context, id, quotation.lines[0]!.id, { quantity: 123 }),
        ),
      ]);

      const after = await view(id);
      if (after.status === 'SENT') {
        // If it sent, the approved figures must be the ones on file.
        expect(after.approvedPayloadHash).toBe(after.currentPayloadHash);
      } else {
        expect(after.status).toBe('DRAFT');
      }
      expect(sent.status).toBe('fulfilled');
      expect(edited.status).toBe('fulfilled');
    });
  });

  describe('audit', () => {
    it('records the whole lifecycle', async () => {
      const { id } = await draft();
      const quotation = await view(id);
      await withTenant(org.organizationId, (tx) =>
        setLineDiscount(tx, org.context, id, quotation.lines[0]!.id, { discountBp: 200 }),
      );
      await withTenant(org.organizationId, (tx) => setDeliveryFee(tx, org.context, id, 450_000n));
      await withTenant(org.organizationId, (tx) => submitForApproval(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => approve(tx, org.context, id));
      await withTenant(org.organizationId, (tx) => markSent(tx, org.context, id));

      const actions = (
        await owner.auditEvent.findMany({ where: { entityId: id }, orderBy: { sequence: 'asc' } })
      ).map((event) => event.action);

      for (const expected of [
        'quotation.created',
        'quotation.discount_edited',
        'quotation.delivery_fee_edited',
        'quotation.submitted',
        'quotation.approved',
        'quotation.marked_sent',
      ]) {
        expect(actions, expected).toContain(expected);
      }
    });

    it('rolls an edit back together with its audit row', async () => {
      const { id } = await draft();
      const quotation = await view(id);
      const before = await owner.auditEvent.count({ where: { entityId: id } });

      await expect(
        withTenant(org.organizationId, async (tx) => {
          const edited = await setLineQuantity(tx, org.context, id, quotation.lines[0]!.id, {
            quantity: 42,
          });
          expect(edited.ok).toBe(true);
          throw new Error('simulated failure after the edit');
        }),
      ).rejects.toThrow('simulated failure');

      const line = await owner.quotationItem.findFirstOrThrow({
        where: { quotationId: id, skuSnapshot: 'CEM-OPC-50' },
      });
      expect(line.quantity).toBe(500);
      expect(await owner.auditEvent.count({ where: { entityId: id } })).toBe(before);
    });
  });
});
