import { beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { loadMatchCorpus, matchProduct } from '@/modules/catalog';
import { normalizeAlias } from '@/modules/catalog/normalize';
import {
  confirmItem,
  correctItemProduct,
  createInquiry,
  getInquiry,
  listInquiries,
  markReadyForQuote,
  rejectItem,
  runParse,
} from '@/modules/inquiries';
import { MockAIProvider } from '@/platform/ai/mock-provider';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { seedCatalogue } from '../support/catalogue';

/**
 * Cross-tenant safety for the matcher.
 *
 * The Phase 1 tenancy tests prove that a scoped query returns only its own rows. That is not
 * sufficient here, and the difference is the point of this file: the matcher's leak would not
 * look like a leak. A salesperson at Addis Build Supply asking for "12mm rebar" and being shown
 * "Rebar 12mm" would see a correct-looking answer — with another company's price, another
 * company's stock, and a product id that would carry into a quotation in Phase 3.
 *
 * So the second organization here is seeded with *deliberate lookalikes*: same names, same
 * aliases, different prices.
 */
describe('the matcher cannot see another organization', () => {
  let addis: Awaited<ReturnType<typeof seedOrg>>;
  let rift: Awaited<ReturnType<typeof seedOrg>>;
  let provider: MockAIProvider;

  beforeAll(async () => {
    await resetDatabase();
    addis = await seedOrg('Addis Build Supply');
    rift = await seedOrg('Rift Valley Trading');
    provider = new MockAIProvider();

    await seedCatalogue(addis.organizationId);

    // The same product names and aliases, in the other tenant, at different prices.
    for (const [sku, name, aliases, price] of [
      ['RV-RB-12', 'Rebar 12mm', ['12mm', '12 mm', '12mm rebar', '12 fer'], 167_500n],
      ['RV-CEM', 'OPC Cement 50kg', ['OPC cement', 'cement', 'OPC'], 139_000n],
    ] as [string, string, string[], bigint][]) {
      const product = await owner.product.create({
        data: {
          organizationId: rift.organizationId,
          sku,
          name,
          unit: 'piece',
          sellingPriceMinor: price,
          availableStock: 9_999,
        },
      });
      // "12mm" and "12 mm" normalise alike, and the unique index is per organization.
      const seen = new Set<string>();
      for (const alias of aliases) {
        const normalizedAlias = normalizeAlias(alias);
        if (seen.has(normalizedAlias)) continue;
        seen.add(normalizedAlias);

        await owner.productAlias.create({
          data: {
            organizationId: rift.organizationId,
            productId: product.id,
            alias,
            normalizedAlias,
            source: 'SEED',
          },
        });
      }
    }
  });

  it('loads a corpus containing only its own catalogue', async () => {
    const corpus = await withTenant(addis.organizationId, loadMatchCorpus);
    const skus = corpus.map((product) => product.sku);

    expect(skus).toContain('RB-12');
    expect(skus).not.toContain('RV-RB-12');
    expect(skus).not.toContain('RV-CEM');
    expect(skus.every((sku) => !sku.startsWith('RV-'))).toBe(true);
  });

  it('never proposes the other organization’s lookalike product', async () => {
    const corpus = await withTenant(addis.organizationId, loadMatchCorpus);

    for (const request of ['12mm rebar', '12 fer', 'OPC cement', 'cement', 'Rebar 12mm']) {
      const result = matchProduct(request, corpus);
      expect(result.best?.sku, request).not.toMatch(/^RV-/);
      for (const candidate of result.candidates) {
        expect(candidate.sku, `${request} offered ${candidate.sku}`).not.toMatch(/^RV-/);
      }
    }
  });

  it('quotes its own price, not the neighbour’s', async () => {
    const corpus = await withTenant(addis.organizationId, loadMatchCorpus);
    const result = matchProduct('12mm rebar', corpus);

    const product = await owner.product.findFirstOrThrow({
      where: { id: result.best!.productId },
    });
    expect(product.organizationId).toBe(addis.organizationId);
    expect(product.sellingPriceMinor).toBe(142_000n);
  });

  it('shows only its own products through a full parse', async () => {
    const created = await withTenant(addis.organizationId, (tx) =>
      createInquiry(tx, addis.context, { rawMessage: '80 pcs 12mm rebar and 20 bags cement' }),
    );
    if (!created.ok) throw new Error('setup failed');

    await runParse(addis.organizationId, addis.context, created.value.id, provider);
    const view = await withTenant(addis.organizationId, (tx) => getInquiry(tx, created.value.id));
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    for (const item of view.value.items) {
      expect(item.product?.sku).not.toMatch(/^RV-/);
      for (const candidate of item.candidates) {
        expect(candidate.sku).not.toMatch(/^RV-/);
      }
    }
    expect(view.value.items[0]!.product!.sellingPriceMinor).toBe(142_000n);
  });

  it('refuses a crafted correction pointing at a foreign product', async () => {
    // The form post an attacker would try: a valid item id from their own tenant, a product id
    // from someone else's.
    const created = await withTenant(addis.organizationId, (tx) =>
      createInquiry(tx, addis.context, { rawMessage: '80 pcs 12mm rebar' }),
    );
    if (!created.ok) throw new Error('setup failed');
    await runParse(addis.organizationId, addis.context, created.value.id, provider);

    const view = await withTenant(addis.organizationId, (tx) => getInquiry(tx, created.value.id));
    if (!view.ok) throw new Error('setup failed');

    const foreign = await owner.product.findFirstOrThrow({ where: { sku: 'RV-RB-12' } });

    const result = await withTenant(addis.organizationId, (tx) =>
      correctItemProduct(tx, addis.context, view.value.items[0]!.id, foreign.id),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

    const row = await owner.inquiryItemProposal.findUniqueOrThrow({
      where: { id: view.value.items[0]!.id },
    });
    expect(row.matchedProductId).not.toBe(foreign.id);
  });
});

describe('inquiries themselves are tenant-scoped', () => {
  let addis: Awaited<ReturnType<typeof seedOrg>>;
  let rift: Awaited<ReturnType<typeof seedOrg>>;
  let riftInquiryId: string;
  let riftItemId: string;

  beforeAll(async () => {
    await resetDatabase();
    addis = await seedOrg('Addis Build Supply');
    rift = await seedOrg('Rift Valley Trading');
    await seedCatalogue(addis.organizationId);
    await seedCatalogue(rift.organizationId);

    const created = await withTenant(rift.organizationId, (tx) =>
      createInquiry(tx, rift.context, { rawMessage: '80 pcs 12mm rebar' }),
    );
    if (!created.ok) throw new Error('setup failed');
    riftInquiryId = created.value.id;

    await runParse(rift.organizationId, rift.context, riftInquiryId, new MockAIProvider());
    const view = await withTenant(rift.organizationId, (tx) => getInquiry(tx, riftInquiryId));
    if (!view.ok) throw new Error('setup failed');
    riftItemId = view.value.items[0]!.id;
  });

  it('cannot read another organization’s inquiry', async () => {
    const result = await withTenant(addis.organizationId, (tx) => getInquiry(tx, riftInquiryId));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
  });

  it('cannot list another organization’s inquiries', async () => {
    const rows = await withTenant(addis.organizationId, (tx) => listInquiries(tx));
    expect(rows).toEqual([]);
  });

  it('cannot parse another organization’s inquiry', async () => {
    const result = await runParse(
      addis.organizationId,
      addis.context,
      riftInquiryId,
      new MockAIProvider(),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
  });

  it('cannot confirm, correct or reject another organization’s item', async () => {
    for (const action of [confirmItem, rejectItem]) {
      const result = await withTenant(addis.organizationId, (tx) =>
        action(tx, addis.context, riftItemId),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
    }

    const row = await owner.inquiryItemProposal.findUniqueOrThrow({ where: { id: riftItemId } });
    expect(row.reviewStatus).toBe('SUGGESTED');
  });

  it('cannot mark another organization’s inquiry ready', async () => {
    const result = await withTenant(addis.organizationId, (tx) =>
      markReadyForQuote(tx, addis.context, riftInquiryId),
    );
    expect(result.ok).toBe(false);

    const row = await owner.inquiry.findUniqueOrThrow({ where: { id: riftInquiryId } });
    expect(row.status).toBe('NEEDS_REVIEW');
  });

  it('cannot see another organization’s AI interaction records', async () => {
    const mine = await withTenant(addis.organizationId, (tx) => tx.aiInteraction.count());
    const theirs = await owner.aiInteraction.count({
      where: { organizationId: rift.organizationId },
    });
    expect(theirs).toBeGreaterThan(0);
    expect(mine).toBe(0);
  });
});
