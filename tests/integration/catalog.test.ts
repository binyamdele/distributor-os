import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { adjustStock, createProduct, freeStock, getProduct, isLowStock } from '@/modules/catalog';
import { owner, resetDatabase, seedOrg, seedProduct } from '../support/fixtures';

describe('products', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply');
  });

  describe('creation', () => {
    it('stores the price in minor units and the tax rate in basis points', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        createProduct(
          tx,
          org.context,
          {
            sku: 'RB-12',
            name: 'Rebar 12mm',
            unit: 'piece',
            sellingPrice: '1420.00',
            taxRatePercent: 15,
            availableStock: 620,
            reorderThreshold: 600,
          },
          'ETB',
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sellingPriceMinor).toBe(142_000n);
      expect(result.value.taxRateBp).toBe(1500);
    });

    it('refuses a price with more precision than ETB has', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        createProduct(
          tx,
          org.context,
          { sku: 'RB-12', name: 'Rebar 12mm', unit: 'piece', sellingPrice: '1420.005' },
          'ETB',
        ),
      );
      expect(result.ok).toBe(false);
    });

    it('refuses a duplicate SKU within the organization', async () => {
      const input = {
        sku: 'RB-12',
        name: 'Rebar 12mm',
        unit: 'piece',
        sellingPrice: '1420.00',
      };
      await withTenant(org.organizationId, (tx) =>
        createProduct(tx, org.context, input, 'ETB'),
      );
      const second = await withTenant(org.organizationId, (tx) =>
        createProduct(tx, org.context, input, 'ETB'),
      );

      expect(second.ok).toBe(false);
      expect(second.ok === false && second.error.code).toBe('CONFLICT');
    });

    it('allows the same SKU in a different organization', async () => {
      const other = await seedOrg('Rift Valley Trading');
      const input = { sku: 'RB-12', name: 'Rebar 12mm', unit: 'piece', sellingPrice: '1420.00' };

      const first = await withTenant(org.organizationId, (tx) =>
        createProduct(tx, org.context, input, 'ETB'),
      );
      const second = await withTenant(other.organizationId, (tx) =>
        createProduct(tx, other.context, input, 'ETB'),
      );

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    });

    it('stores aliases in normalised form, de-duplicated', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        createProduct(
          tx,
          org.context,
          {
            sku: 'RB-12',
            name: 'Rebar 12mm',
            unit: 'piece',
            sellingPrice: '1420.00',
            aliases: '12mm\n12 mm\n12MM\n12 mm steel',
          },
          'ETB',
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = await withTenant(org.organizationId, (tx) =>
        getProduct(tx, result.value.id),
      );
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;

      expect(stored.value.aliases.map((a) => a.normalizedAlias).sort()).toEqual([
        '12mm',
        '12mm steel',
      ]);
    });
  });

  describe('stock adjustment', () => {
    let productId: string;

    beforeEach(async () => {
      productId = await seedProduct(org.organizationId, 'RB-12', { availableStock: 100 });
    });

    it('increases stock and records the reason', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        adjustStock(tx, org.context, productId, { delta: 50, reason: 'Delivery received' }),
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.stockAfter).toBe(150);

      const [adjustment] = await owner.stockAdjustment.findMany({ where: { productId } });
      expect(adjustment).toMatchObject({
        delta: 50,
        stockAfter: 150,
        reason: 'Delivery received',
        actorId: org.userId,
      });
    });

    it('decreases stock', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        adjustStock(tx, org.context, productId, { delta: -30, reason: 'Damaged' }),
      );
      expect(result.ok && result.value.stockAfter).toBe(70);
    });

    it('refuses a change that would drive stock negative', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        adjustStock(tx, org.context, productId, { delta: -101, reason: 'Too much' }),
      );

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('INSUFFICIENT_STOCK');

      const product = await owner.product.findUniqueOrThrow({ where: { id: productId } });
      expect(product.availableStock).toBe(100);
      expect(await owner.stockAdjustment.count()).toBe(0);
    });

    it('refuses a zero change', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        adjustStock(tx, org.context, productId, { delta: 0, reason: 'Nothing' }),
      );
      expect(result.ok).toBe(false);
    });

    it('requires a reason', async () => {
      const result = await withTenant(org.organizationId, (tx) =>
        adjustStock(tx, org.context, productId, { delta: 10, reason: '' }),
      );
      expect(result.ok).toBe(false);
    });

    it('loses no adjustment when several run at once', async () => {
      // A read-then-write implementation loses adjustments here: every writer reads 100 and
      // writes its own result. The conditional UPDATE is what makes the total correct.
      const deltas = [10, -5, 20, -15, 30, -25, 40, -35];

      await Promise.all(
        deltas.map((delta) =>
          withTenant(org.organizationId, (tx) =>
            adjustStock(tx, org.context, productId, { delta, reason: `concurrent ${delta}` }),
          ),
        ),
      );

      const product = await owner.product.findUniqueOrThrow({ where: { id: productId } });
      const expected = 100 + deltas.reduce((total, delta) => total + delta, 0);

      expect(product.availableStock).toBe(expected);
      expect(await owner.stockAdjustment.count()).toBe(deltas.length);
    });
  });

  describe('free stock and low stock', () => {
    it('subtracts reserved stock from what is on hand', () => {
      expect(freeStock({ availableStock: 620, reservedStock: 80 })).toBe(540);
    });

    it('flags a product at or below its reorder threshold', () => {
      expect(isLowStock({ availableStock: 620, reservedStock: 80, reorderThreshold: 600 })).toBe(
        true,
      );
      expect(isLowStock({ availableStock: 620, reservedStock: 0, reorderThreshold: 600 })).toBe(
        false,
      );
    });

    it('never flags a product with no threshold set', () => {
      expect(isLowStock({ availableStock: 0, reservedStock: 0, reorderThreshold: 0 })).toBe(false);
    });
  });
});
