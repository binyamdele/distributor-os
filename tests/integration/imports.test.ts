import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import {
  commitCustomers,
  commitOpeningStock,
  commitProducts,
  previewOpeningStock,
  previewProducts,
} from '@/modules/imports';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';

/**
 * Import against a real PostgreSQL.
 *
 * The unit tests pin the parsing rules. What can only be proved here is that a commit is
 * genuinely all-or-nothing, that the same opening-stock file cannot be applied twice, that the
 * baseline lands in the ledger, and that one organization's import cannot reach another's rows.
 */

const products = (rows: string) =>
  `sku,name,category,unit,selling_price,tax_rate_percent,reorder_threshold\n${rows}`;
const customers = (rows: string) =>
  `company_name,contact_name,phone,email,address,credit_status,credit_limit,payment_terms_days\n${rows}`;
const stock = (rows: string) => `sku,quantity\n${rows}`;

const CATALOGUE = products(
  'CEM-OPC-50,OPC Cement 50kg,Cement,bag,1250.00,15,1000\nRB-12,Rebar 12mm,Reinforcement,piece,1420.00,15,600',
);

type Org = Awaited<ReturnType<typeof seedOrg>>;

describe('importing a catalogue', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('creates products with exact prices and an alias for each', async () => {
    const result = await withTenant(org.organizationId, (tx) =>
      commitProducts(tx, org.context, CATALOGUE, { filename: 'products.csv' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(2);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    // Exact minor units. A float round-trip would land on 124999 or 125001 here.
    expect(cement.sellingPriceMinor).toBe(125_000n);
    expect(cement.taxRateBp).toBe(1500);
    expect(cement.reorderThreshold).toBe(1000);
    // Stock is deliberately untouched by a catalogue import.
    expect(cement.availableStock).toBe(0);

    // The product's own name becomes its first alias, so Phase 2's matcher works from day one.
    const alias = await owner.productAlias.findFirst({ where: { productId: cement.id } });
    expect(alias).not.toBeNull();
    expect(alias!.alias).toBe('OPC Cement 50kg');
  });

  it('updates an existing product rather than duplicating its SKU', async () => {
    await withTenant(org.organizationId, (tx) => commitProducts(tx, org.context, CATALOGUE));

    const repriced = products('CEM-OPC-50,OPC Cement 50kg,Cement,bag,1300.00,15,1200');
    const result = await withTenant(org.organizationId, (tx) =>
      commitProducts(tx, org.context, repriced),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(0);
    expect(result.value.updated).toBe(1);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.sellingPriceMinor).toBe(130_000n);
    expect(await owner.product.count({ where: { organizationId: org.organizationId } })).toBe(2);
  });

  it('writes nothing at all when one row is invalid', async () => {
    // All-or-nothing. Half a catalogue with no clear way to tell which half is worse than none.
    const broken = products(
      'CEM-OPC-50,OPC Cement 50kg,Cement,bag,1250.00,15,1000\nRB-12,Rebar 12mm,,sackful,1420.00,15,600',
    );

    const result = await withTenant(org.organizationId, (tx) =>
      commitProducts(tx, org.context, broken),
    );

    expect(result.ok).toBe(false);
    expect(await owner.product.count({ where: { organizationId: org.organizationId } })).toBe(0);
  });

  it('records the import so the same file is recognised again', async () => {
    await withTenant(org.organizationId, (tx) => commitProducts(tx, org.context, CATALOGUE));

    const preview = await withTenant(org.organizationId, (tx) =>
      previewProducts(tx, CATALOGUE),
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.alreadyImportedAt).not.toBeNull();

    const second = await withTenant(org.organizationId, (tx) =>
      commitProducts(tx, org.context, CATALOGUE),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
  });

  it('allows a deliberate re-import when the operator acknowledges it', async () => {
    // Products are not stock: re-importing a price list on purpose is legitimate.
    await withTenant(org.organizationId, (tx) => commitProducts(tx, org.context, CATALOGUE));
    const again = await withTenant(org.organizationId, (tx) =>
      commitProducts(tx, org.context, CATALOGUE, { acknowledgeDuplicate: true }),
    );
    expect(again.ok).toBe(true);
  });

  it('audits the import', async () => {
    await withTenant(org.organizationId, (tx) =>
      commitProducts(tx, org.context, CATALOGUE, { filename: 'products.csv' }),
    );

    const event = await owner.auditEvent.findFirst({
      where: { organizationId: org.organizationId, action: 'import.products' },
    });
    expect(event).not.toBeNull();
    expect((event!.newState as Record<string, unknown>).created).toBe(2);
  });
});

describe('importing customers', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('creates customers with exact credit limits', async () => {
    const file = customers(
      'ABC Construction PLC,Tewodros,+251911000101,a@b.example,Bole,CREDIT_ALLOWED,2000000.00,30',
    );

    const result = await withTenant(org.organizationId, (tx) =>
      commitCustomers(tx, org.context, file),
    );
    expect(result.ok).toBe(true);

    const customer = await owner.customer.findFirstOrThrow({
      where: { organizationId: org.organizationId },
    });
    expect(customer.creditLimitMinor).toBe(200_000_000n);
    expect(customer.creditStatus).toBe('CREDIT_ALLOWED');
    expect(customer.paymentTermsDays).toBe(30);
  });

  it('matches an existing customer case-insensitively rather than duplicating them', async () => {
    await owner.customer.create({
      data: {
        organizationId: org.organizationId,
        companyName: 'ABC Construction PLC',
        creditStatus: 'CASH_ONLY',
        creditLimitMinor: 0n,
        paymentTermsDays: 0,
      },
    });

    const file = customers('abc construction plc,,,,,CREDIT_ALLOWED,500000.00,15');
    const result = await withTenant(org.organizationId, (tx) =>
      commitCustomers(tx, org.context, file),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(0);
    expect(result.value.updated).toBe(1);
    // One debtor, one ledger.
    expect(await owner.customer.count({ where: { organizationId: org.organizationId } })).toBe(1);
  });
});

describe('importing opening stock', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await withTenant(org.organizationId, (tx) => commitProducts(tx, org.context, CATALOGUE));
  });

  it('sets the balance and records it in the ledger', async () => {
    const result = await withTenant(org.organizationId, (tx) =>
      commitOpeningStock(tx, org.context, stock('CEM-OPC-50,4800\nRB-12,620'), {
        filename: 'opening.csv',
      }),
    );

    expect(result.ok).toBe(true);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.availableStock).toBe(4800);
    expect(cement.reservedStock).toBe(0);

    // §37: the baseline is a ledger event, not a number that simply appeared. Everything after
    // it is a movement *from* a known starting point.
    const movement = await owner.inventoryMovement.findFirstOrThrow({
      where: { organizationId: org.organizationId, productId: cement.id },
    });
    expect(movement.movementType).toBe('OPENING_BALANCE');
    expect(movement.delta).toBe(4800);
    expect(movement.stockAfter).toBe(4800);
    expect(movement.reason).toContain('opening.csv');
  });

  it('refuses the same file twice, because doubling a yard is invisible', async () => {
    const file = stock('CEM-OPC-50,4800');
    const first = await withTenant(org.organizationId, (tx) =>
      commitOpeningStock(tx, org.context, file),
    );
    expect(first.ok).toBe(true);

    const second = await withTenant(org.organizationId, (tx) =>
      commitOpeningStock(tx, org.context, file),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('CONFLICT');
      expect(second.error.message).toContain('double');
    }

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.availableStock).toBe(4800);
  });

  it('refuses a different file covering a product already counted', async () => {
    // The case the fingerprint alone cannot catch: a re-exported file, one row edited, saved
    // under a new name. Without this, "opening stock" quietly becomes "add this much stock".
    await withTenant(org.organizationId, (tx) =>
      commitOpeningStock(tx, org.context, stock('CEM-OPC-50,4800')),
    );

    const different = stock('CEM-OPC-50,4801');
    const preview = await withTenant(org.organizationId, (tx) =>
      previewOpeningStock(tx, different),
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // A genuinely new file — so the duplicate check does not fire — and still refused.
    expect(preview.value.alreadyImportedAt).toBeNull();
    expect(preview.value.canCommit).toBe(false);
    expect(preview.value.alreadyStocked).toContain('CEM-OPC-50');

    const result = await withTenant(org.organizationId, (tx) =>
      commitOpeningStock(tx, org.context, different),
    );
    expect(result.ok).toBe(false);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.availableStock).toBe(4800);
  });

  it('refuses a SKU that is not in the catalogue', async () => {
    const result = await withTenant(org.organizationId, (tx) =>
      commitOpeningStock(tx, org.context, stock('NOT-A-SKU,100')),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('valid');
  });

  it('writes nothing when one row is bad', async () => {
    const result = await withTenant(org.organizationId, (tx) =>
      commitOpeningStock(tx, org.context, stock('CEM-OPC-50,4800\nNOT-A-SKU,100')),
    );
    expect(result.ok).toBe(false);

    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.availableStock).toBe(0);
    expect(await owner.inventoryMovement.count({ where: { organizationId: org.organizationId } })).toBe(0);
  });

  it('rolls everything back when the transaction fails afterwards', async () => {
    await expect(
      withTenant(org.organizationId, async (tx) => {
        const result = await commitOpeningStock(tx, org.context, stock('CEM-OPC-50,4800'));
        expect(result.ok).toBe(true);
        throw new Error('something later in the request failed');
      }),
    ).rejects.toThrow('something later');

    // Stock, the ledger entry and the import record unwind together — otherwise the import
    // record would block a legitimate retry of an import that never happened.
    const cement = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(cement.availableStock).toBe(0);
    expect(await owner.inventoryMovement.count({ where: { organizationId: org.organizationId } })).toBe(0);
    // Scoped to this kind: the beforeEach imported a catalogue, whose job row legitimately
    // remains. What must be absent is a record of the opening-stock import that rolled back —
    // otherwise it would block a legitimate retry of an import that never happened.
    expect(
      await owner.importJob.count({
        where: { organizationId: org.organizationId, kind: 'OPENING_STOCK' },
      }),
    ).toBe(0);
  });
});

describe('tenant isolation', () => {
  let orgA: Org;
  let orgB: Org;

  beforeEach(async () => {
    await resetDatabase();
    orgA = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    orgB = await seedOrg('Bole Trading', 'OWNER_ADMIN');
  });

  it('keeps an import inside the organization that ran it', async () => {
    await withTenant(orgA.organizationId, (tx) => commitProducts(tx, orgA.context, CATALOGUE));

    expect(await owner.product.count({ where: { organizationId: orgA.organizationId } })).toBe(2);
    expect(await owner.product.count({ where: { organizationId: orgB.organizationId } })).toBe(0);
  });

  it('does not let one organization import record suppress another', async () => {
    // The fingerprint is scoped per organization. Two distributors legitimately importing the
    // same template must not block each other.
    await withTenant(orgA.organizationId, (tx) => commitProducts(tx, orgA.context, CATALOGUE));

    const theirs = await withTenant(orgB.organizationId, (tx) =>
      commitProducts(tx, orgB.context, CATALOGUE),
    );
    expect(theirs.ok).toBe(true);
    if (theirs.ok) expect(theirs.value.created).toBe(2);
  });

  it('does not let one organization see another opening stock as already counted', async () => {
    await withTenant(orgA.organizationId, (tx) => commitProducts(tx, orgA.context, CATALOGUE));
    await withTenant(orgA.organizationId, (tx) =>
      commitOpeningStock(tx, orgA.context, stock('CEM-OPC-50,4800')),
    );

    await withTenant(orgB.organizationId, (tx) => commitProducts(tx, orgB.context, CATALOGUE));
    const theirs = await withTenant(orgB.organizationId, (tx) =>
      commitOpeningStock(tx, orgB.context, stock('CEM-OPC-50,4800')),
    );

    expect(theirs.ok).toBe(true);

    const mine = await owner.product.findFirstOrThrow({
      where: { organizationId: orgA.organizationId, sku: 'CEM-OPC-50' },
    });
    expect(mine.availableStock).toBe(4800);
  });
});
