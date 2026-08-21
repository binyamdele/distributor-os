import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import {
  confirmItem,
  correctItemProduct,
  correctItemQuantity,
  createInquiry,
  getInquiry,
  listInquiries,
  markItemUnresolved,
  markReadyForQuote,
  rejectItem,
  runParse,
} from '@/modules/inquiries';
import { matchMetrics, parsingMetrics } from '@/modules/inquiries/metrics';
import { MOCK_MALFORMED_SENTINEL, MockAIProvider } from '@/platform/ai/mock-provider';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { seedCatalogue } from '../support/catalogue';

const CLEAN_MESSAGE =
  "Selam, 500 bags OPC cement, 80 pcs 12mm rebar, 50 pcs 10mm. Please send today's price. Delivery to Bole Bulbula.";

describe('inquiries', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let provider: MockAIProvider;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply');
    await seedCatalogue(org.organizationId);
    provider = new MockAIProvider();
  });

  async function create(message = CLEAN_MESSAGE): Promise<string> {
    const result = await withTenant(org.organizationId, (tx) =>
      createInquiry(tx, org.context, { rawMessage: message, channel: 'WHATSAPP' }),
    );
    if (!result.ok) throw new Error('inquiry creation failed in setup');
    return result.value.id;
  }

  describe('creation', () => {
    it('stores the customer message verbatim', async () => {
      const id = await create();
      const row = await owner.inquiry.findUniqueOrThrow({ where: { id } });
      expect(row.rawMessage).toBe(CLEAN_MESSAGE);
      expect(row.status).toBe('RECEIVED');
      expect(row.createdById).toBe(org.userId);
    });

    it('does not put the message text into the audit log', async () => {
      // The message is stored once, on its own row. The audit log is exported and retained far
      // more widely, and customer text has no business being duplicated into it.
      await create();
      const [event] = await owner.auditEvent.findMany({ where: { action: 'inquiry.created' } });
      expect(JSON.stringify(event?.newState)).not.toContain('OPC cement');
      expect(JSON.stringify(event?.newState)).toContain('messageFingerprint');
    });

    it('refuses an empty message', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        createInquiry(tx, org.context, { rawMessage: '   ' }),
      );
      expect(result.ok).toBe(false);
    });

    it('accepts a channel other than manual without connecting to anything', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        createInquiry(tx, org.context, { rawMessage: 'hello', channel: 'TELEGRAM' }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('parsing', () => {
    it('reads the message into matched, priced, stock-checked lines', async () => {
      const id = await create();
      const parsed = await runParse(org.organizationId, org.context, id, provider);

      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.value.itemCount).toBe(3);

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      expect(view.ok).toBe(true);
      if (!view.ok) return;

      expect(view.value.status).toBe('NEEDS_REVIEW');
      expect(view.value.intent).toBe('REQUEST_QUOTATION');
      expect(view.value.destinationText).toBe('Bole Bulbula');

      const skus = view.value.items.map((item) => item.product?.sku);
      expect(skus).toEqual(['CEM-OPC-50', 'RB-12', 'RB-10']);

      // Every one of these came from the database, not from the model.
      const [cement] = view.value.items;
      expect(cement!.product!.sellingPriceMinor).toBe(125_000n);
      expect(cement!.product!.freeStock).toBe(4_800);
      expect(cement!.matchMethod).toBe('ALIAS');
      expect(cement!.proposedConfidence).toBe(0.98);
      expect(cement!.band).toBe('strong');
    });

    it('leaves every line needing a human decision', async () => {
      const id = await create();
      await runParse(org.organizationId, org.context, id, provider);

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      expect(view.ok).toBe(true);
      if (!view.ok) return;

      // A high-confidence proposal is still a proposal.
      for (const item of view.value.items) {
        expect(item.reviewStatus).toBe('SUGGESTED');
        expect(item.humanDecided).toBe(false);
      }
      expect(view.value.readiness.ready).toBe(false);
    });

    it('records which provider, model and prompt produced the answer', async () => {
      const id = await create();
      await runParse(org.organizationId, org.context, id, provider);

      const [interaction] = await owner.aiInteraction.findMany({ where: { inquiryId: id } });
      expect(interaction).toMatchObject({
        purpose: 'parse_inquiry',
        provider: 'mock',
        valid: true,
        itemCount: 3,
      });
      expect(interaction!.promptVersion).toMatch(/^parse-inquiry\//);
      // A fingerprint, not the message: no customer text in the metadata table.
      expect(interaction!.inputFingerprint).toHaveLength(64);
    });

    it('warns rather than blocks when stock is short', async () => {
      const id = await create('We need 400 pcs 16mm rebar for the Kality site. What is the price?');
      await runParse(org.organizationId, org.context, id, provider);

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      expect(view.ok).toBe(true);
      if (!view.ok) return;

      const [item] = view.value.items;
      expect(item!.product?.sku).toBe('RB-16');
      expect(item!.stockShortfall).toBe(240 - 400);

      await withTenant(org.organizationId, (tx) => confirmItem(tx, org.context, item!.id));
      const confirmed = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      expect(confirmed.ok && confirmed.value.readiness.ready).toBe(true);
      expect(confirmed.ok && confirmed.value.readiness.warnings[0]?.message).toMatch(/short by 160/);
    });

    it('does not resolve an ambiguous request', async () => {
      const id = await create('Called asking for 200 rebar for a slab.');
      await runParse(org.organizationId, org.context, id, provider);

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      expect(view.ok).toBe(true);
      if (!view.ok) return;

      const [item] = view.value.items;
      expect(item!.ambiguous).toBe(true);
      expect(item!.band).not.toBe('strong');
      expect(item!.candidates.length).toBeGreaterThan(1);
      expect(view.value.readiness.ready).toBe(false);
    });

    it('leaves an unknown product unresolved', async () => {
      const id = await create('Please quote 30 pcs PVC pipe 4 inch.');
      await runParse(org.organizationId, org.context, id, provider);

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      expect(view.ok).toBe(true);
      if (!view.ok) return;

      const [item] = view.value.items;
      expect(item!.reviewStatus).toBe('UNRESOLVED');
      expect(item!.product).toBeNull();
      expect(item!.matchMethod).toBe('UNRESOLVED');
      expect(view.value.readiness.ready).toBe(false);
    });

    it('matches an alias the customer used instead of the catalogue name', async () => {
      const id = await create('300 bags of cement and 40 pcs 12 fer please');
      await runParse(org.organizationId, org.context, id, provider);

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      expect(view.ok && view.value.items.map((item) => item.product?.sku)).toEqual([
        'CEM-OPC-50',
        'RB-12',
      ]);
      expect(view.ok && view.value.items.every((item) => item.matchMethod === 'ALIAS')).toBe(true);
    });
  });

  describe('when the provider answers badly', () => {
    it('fails safely on schema-invalid output and changes nothing', async () => {
      const message = `Need 20 bags cement. ${MOCK_MALFORMED_SENTINEL}`;
      const id = await create(message);

      const result = await runParse(org.organizationId, org.context, id, provider);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('AI_OUTPUT_INVALID');
      expect(result.ok === false && result.error.requiresHumanReview).toBe(true);

      const row = await owner.inquiry.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('PARSE_FAILED');
      // The customer's text survives untouched — that is the whole point of failing here.
      expect(row.rawMessage).toBe(message);
      expect(row.parseError).toContain('SCHEMA_INVALID');
      // Nothing was coerced into the item table.
      expect(await owner.inquiryItemProposal.count()).toBe(0);
    });

    it('records the failed call with its error code', async () => {
      const id = await create(`x ${MOCK_MALFORMED_SENTINEL}`);
      await runParse(org.organizationId, org.context, id, provider);

      const [interaction] = await owner.aiInteraction.findMany({ where: { inquiryId: id } });
      expect(interaction).toMatchObject({ valid: false, errorCode: 'SCHEMA_INVALID' });
    });

    it('fails safely when the provider is unreachable', async () => {
      const id = await create('10 bags cement');
      provider.setFailure('10 bags cement', 'PROVIDER_ERROR');

      const result = await runParse(org.organizationId, org.context, id, provider);
      expect(result.ok === false && result.error.code).toBe('PROVIDER_ERROR');
      expect((await owner.inquiry.findUniqueOrThrow({ where: { id } })).status).toBe('PARSE_FAILED');
    });

    it('can be parsed again after a failure', async () => {
      const message = `Need 20 bags cement. ${MOCK_MALFORMED_SENTINEL}`;
      const id = await create(message);
      await runParse(org.organizationId, org.context, id, provider);

      // The second attempt gets a well-formed answer for the same text.
      provider.setRawResponse(message, {
        intent: 'REQUEST_QUOTATION',
        items: [{ rawName: 'cement', quantity: 20, unit: 'bags' }],
      });

      const retry = await runParse(org.organizationId, org.context, id, provider);
      expect(retry.ok).toBe(true);

      const row = await owner.inquiry.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('NEEDS_REVIEW');
      expect(row.parseError).toBeNull();
    });
  });

  describe('state transitions', () => {
    it('refuses to parse an inquiry that is already ready', async () => {
      const id = await create('20 bags cement');
      await runParse(org.organizationId, org.context, id, provider);

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      if (!view.ok) throw new Error('unreachable');
      await withTenant(org.organizationId, (tx) =>
        confirmItem(tx, org.context, view.value.items[0]!.id),
      );
      await withTenant(org.organizationId, (tx) => markReadyForQuote(tx, org.context, id));

      const again = await runParse(org.organizationId, org.context, id, provider);
      expect(again.ok).toBe(false);
      expect(again.ok === false && again.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('refuses to mark an unreviewed inquiry ready', async () => {
      const id = await create();
      await runParse(org.organizationId, org.context, id, provider);

      const result = await withTenant(org.organizationId, (tx) =>
        markReadyForQuote(tx, org.context, id),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('VALIDATION_FAILED');
    });

    it('withdraws readiness when a reviewed item is changed afterwards', async () => {
      const id = await create('20 bags cement');
      await runParse(org.organizationId, org.context, id, provider);

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      if (!view.ok) throw new Error('unreachable');
      const itemId = view.value.items[0]!.id;

      await withTenant(org.organizationId, (tx) => confirmItem(tx, org.context, itemId));
      await withTenant(org.organizationId, (tx) => markReadyForQuote(tx, org.context, id));
      expect((await owner.inquiry.findUniqueOrThrow({ where: { id } })).status).toBe(
        'READY_FOR_QUOTE',
      );

      // Readiness is a claim about a specific set of reviewed lines. Editing one retracts it.
      await withTenant(org.organizationId, (tx) =>
        correctItemQuantity(tx, org.context, itemId, { quantity: 25 }),
      );

      const after = await owner.inquiry.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe('NEEDS_REVIEW');
      expect(after.readyAt).toBeNull();
    });

    it('refuses a review action on an inquiry that has not been parsed', async () => {
      const id = await create('20 bags cement');
      await runParse(org.organizationId, org.context, id, provider);
      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      if (!view.ok) throw new Error('unreachable');
      const itemId = view.value.items[0]!.id;

      await owner.inquiry.update({ where: { id }, data: { status: 'RECEIVED' } });

      const result = await withTenant(org.organizationId, (tx) =>
        confirmItem(tx, org.context, itemId),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('review', () => {
    let inquiryId: string;
    let itemIds: string[];

    beforeEach(async () => {
      inquiryId = await create();
      await runParse(org.organizationId, org.context, inquiryId, provider);
      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, inquiryId));
      if (!view.ok) throw new Error('unreachable');
      itemIds = view.value.items.map((item) => item.id);
    });

    it('confirming accepts the proposal and keeps it visible', async () => {
      await withTenant(org.organizationId, (tx) => confirmItem(tx, org.context, itemIds[0]!));

      const row = await owner.inquiryItemProposal.findUniqueOrThrow({ where: { id: itemIds[0]! } });
      expect(row.reviewStatus).toBe('CONFIRMED');
      expect(row.matchedProductId).toBe(row.proposedProductId);
      expect(row.reviewedById).toBe(org.userId);
      // The machine's method survives the human's decision, so acceptance and correction rates
      // stay tellable apart.
      expect(row.matchMethod).toBe('ALIAS');
    });

    it('correcting records both the proposal and the override', async () => {
      const rb08 = await owner.product.findFirstOrThrow({
        where: { organizationId: org.organizationId, sku: 'RB-08' },
      });

      await withTenant(org.organizationId, (tx) =>
        correctItemProduct(tx, org.context, itemIds[1]!, rb08.id),
      );

      const row = await owner.inquiryItemProposal.findUniqueOrThrow({ where: { id: itemIds[1]! } });
      expect(row.reviewStatus).toBe('CORRECTED');
      expect(row.matchedProductId).toBe(rb08.id);
      expect(row.proposedProductId).not.toBe(rb08.id);

      const [event] = await owner.auditEvent.findMany({
        where: { action: 'inquiry.item_corrected' },
      });
      expect((event?.newState as Record<string, unknown>).overrodeProposal).toBe(true);
    });

    it('rejecting removes a line from consideration', async () => {
      for (const id of itemIds) {
        await withTenant(org.organizationId, (tx) => rejectItem(tx, org.context, id));
      }
      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, inquiryId));
      expect(view.ok && view.value.readiness.retainedCount).toBe(0);
      expect(view.ok && view.value.readiness.ready).toBe(false);
    });

    it('marking unresolved blocks readiness', async () => {
      await withTenant(org.organizationId, async (tx) => {
        await confirmItem(tx, org.context, itemIds[0]!);
        await confirmItem(tx, org.context, itemIds[1]!);
        await markItemUnresolved(tx, org.context, itemIds[2]!);
      });

      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, inquiryId));
      expect(view.ok && view.value.readiness.ready).toBe(false);
    });

    it('refuses to confirm a line with nothing proposed', async () => {
      const id = await create('Please quote 30 pcs PVC pipe 4 inch.');
      await runParse(org.organizationId, org.context, id, provider);
      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      if (!view.ok) throw new Error('unreachable');

      const result = await withTenant(org.organizationId, (tx) =>
        confirmItem(tx, org.context, view.value.items[0]!.id),
      );
      expect(result.ok).toBe(false);
    });

    it('refuses a quantity of zero', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        correctItemQuantity(tx, org.context, itemIds[0]!, { quantity: 0 }),
      );
      expect(result.ok).toBe(false);
    });

    it('reaches ready once every line is decided', async () => {
      await withTenant(org.organizationId, async (tx) => {
        for (const id of itemIds) await confirmItem(tx, org.context, id);
      });

      const result = await withTenant(org.organizationId, (tx) =>
        markReadyForQuote(tx, org.context, inquiryId),
      );
      expect(result.ok).toBe(true);

      const row = await owner.inquiry.findUniqueOrThrow({ where: { id: inquiryId } });
      expect(row.status).toBe('READY_FOR_QUOTE');
      expect(row.readyAt).not.toBeNull();
    });
  });

  describe('audit', () => {
    it('records the whole lifecycle in order', async () => {
      const id = await create('20 bags cement');
      await runParse(org.organizationId, org.context, id, provider);
      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      if (!view.ok) throw new Error('unreachable');
      await withTenant(org.organizationId, (tx) =>
        confirmItem(tx, org.context, view.value.items[0]!.id),
      );
      await withTenant(org.organizationId, (tx) => markReadyForQuote(tx, org.context, id));

      const events = await owner.auditEvent.findMany({
        where: { organizationId: org.organizationId },
        orderBy: { sequence: 'asc' },
      });
      const actions = events.map((event) => event.action);

      expect(actions).toContain('inquiry.created');
      expect(actions).toContain('inquiry.parse_started');
      expect(actions).toContain('inquiry.parse_succeeded');
      expect(actions).toContain('inquiry.item_confirmed');
      expect(actions).toContain('inquiry.ready_for_quote');
      expect(actions.indexOf('inquiry.created')).toBeLessThan(
        actions.indexOf('inquiry.ready_for_quote'),
      );
    });

    it('marks AI involvement and keeps the confidence that was acted on', async () => {
      const id = await create('20 bags cement');
      await runParse(org.organizationId, org.context, id, provider);
      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      if (!view.ok) throw new Error('unreachable');
      await withTenant(org.organizationId, (tx) =>
        confirmItem(tx, org.context, view.value.items[0]!.id),
      );

      const [event] = await owner.auditEvent.findMany({
        where: { action: 'inquiry.item_confirmed' },
      });
      expect(event?.aiInvolved).toBe(true);
      expect(Number(event?.confidence)).toBeCloseTo(0.98, 4);
    });

    it('rolls a review back together with its audit row', async () => {
      // The Phase 1 guarantee, still holding across the Phase 2 tables: a confirmation that
      // does not commit must not leave an audit entry claiming it did.
      const id = await create('20 bags cement');
      await runParse(org.organizationId, org.context, id, provider);
      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      if (!view.ok) throw new Error('unreachable');
      const itemId = view.value.items[0]!.id;

      await expect(
        withTenant(org.organizationId, async (tx) => {
          const confirmed = await confirmItem(tx, org.context, itemId);
          expect(confirmed.ok).toBe(true);
          throw new Error('simulated failure after the review was written');
        }),
      ).rejects.toThrow('simulated failure');

      const item = await owner.inquiryItemProposal.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.reviewStatus).toBe('SUGGESTED');
      expect(item.matchedProductId).toBeNull();

      const events = await owner.auditEvent.findMany({ where: { action: 'inquiry.item_confirmed' } });
      expect(events).toHaveLength(0);
    });
  });

  describe('listing and metrics', () => {
    it('surfaces how many lines still need attention', async () => {
      const id = await create();
      await runParse(org.organizationId, org.context, id, provider);

      const rows = await withTenant(org.organizationId, (tx) => listInquiries(tx));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.itemCount).toBe(3);
      expect(rows[0]!.needsAttention).toBe(3);
    });

    it('reports parse success and match distribution', async () => {
      const good = await create();
      await runParse(org.organizationId, org.context, good, provider);
      const bad = await create(`x ${MOCK_MALFORMED_SENTINEL}`);
      await runParse(org.organizationId, org.context, bad, provider);

      const { parsing, matching } = await withTenant(org.organizationId, async (tx) => ({
        parsing: await parsingMetrics(tx),
        matching: await matchMetrics(tx),
      }));

      expect(parsing.parsedSuccessfully).toBe(1);
      expect(parsing.parseFailed).toBe(1);
      expect(parsing.parseSuccessRate).toBeCloseTo(0.5, 5);
      expect(matching.items).toBe(3);
      expect(matching.byMethod.ALIAS).toBe(3);
      expect(matching.acceptanceRate).toBeNull();
    });

    it('separates acceptance from correction once lines are reviewed', async () => {
      const id = await create();
      await runParse(org.organizationId, org.context, id, provider);
      const view = await withTenant(org.organizationId, (tx) => getInquiry(tx, id));
      if (!view.ok) throw new Error('unreachable');

      const rb08 = await owner.product.findFirstOrThrow({
        where: { organizationId: org.organizationId, sku: 'RB-08' },
      });

      await withTenant(org.organizationId, async (tx) => {
        await confirmItem(tx, org.context, view.value.items[0]!.id);
        await confirmItem(tx, org.context, view.value.items[1]!.id);
        await correctItemProduct(tx, org.context, view.value.items[2]!.id, rb08.id);
      });

      const matching = await withTenant(org.organizationId, (tx) => matchMetrics(tx));
      expect(matching.acceptanceRate).toBeCloseTo(2 / 3, 5);
      expect(matching.correctionRate).toBeCloseTo(1 / 3, 5);
      expect(matching.averageConfidence).toBeGreaterThan(0.9);
    });
  });
});
