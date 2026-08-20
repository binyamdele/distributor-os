import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CrossTenantAccessError, tenantClient, withTenant } from '@/platform/db';
import { createCustomer, getCustomer, listCustomers } from '@/modules/customers';
import { adjustStock, getProduct, listProducts } from '@/modules/catalog';
import { recentAudit } from '@/modules/audit';
import { owner, resetDatabase, seedCustomer, seedOrg, seedProduct } from '../support/fixtures';

/**
 * Cross-tenant isolation, exercised through the paths the application actually uses.
 *
 * The seeding is done as the database owner so that two organizations genuinely have data; the
 * assertions all run through the ordinary tenant-scoped client, as a request would.
 */
describe('tenant isolation', () => {
  let orgA: Awaited<ReturnType<typeof seedOrg>>;
  let orgB: Awaited<ReturnType<typeof seedOrg>>;
  let customerA: string;
  let customerB: string;
  let productA: string;
  let productB: string;

  beforeAll(async () => {
    await resetDatabase();
    orgA = await seedOrg('Addis Build Supply');
    orgB = await seedOrg('Rift Valley Trading');
    customerA = await seedCustomer(orgA.organizationId, 'ABC Construction');
    customerB = await seedCustomer(orgB.organizationId, 'Adama Roads Authority');
    productA = await seedProduct(orgA.organizationId, 'RB-12', { availableStock: 500 });
    productB = await seedProduct(orgB.organizationId, 'RV-GRAVEL', { availableStock: 900 });
  });

  describe('reads', () => {
    /**
     * Positive controls. Without these, every isolation assertion below would still pass on a
     * client that returned nothing at all — which is isolated, and useless.
     */
    it('can fetch its own customer by id', async () => {
      const result = await withTenant(orgA.organizationId, (tx) => getCustomer(tx, customerA));
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.companyName).toBe('ABC Construction');
    });

    it('can fetch its own product by id', async () => {
      const result = await withTenant(orgA.organizationId, (tx) => getProduct(tx, productA));
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.sku).toBe('RB-12');
    });

    it('lists only its own customers', async () => {
      const listed = await withTenant(orgA.organizationId, (tx) => listCustomers(tx));
      expect(listed.map((c) => c.companyName)).toEqual(['ABC Construction']);
    });

    it('cannot fetch another organization customer by id', async () => {
      const result = await withTenant(orgA.organizationId, (tx) => getCustomer(tx, customerB));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
    });

    it('cannot fetch another organization product by id', async () => {
      const result = await withTenant(orgA.organizationId, (tx) => getProduct(tx, productB));
      expect(result.ok).toBe(false);
    });

    it('lists only its own products', async () => {
      const listed = await withTenant(orgB.organizationId, (tx) => listProducts(tx));
      expect(listed.map((p) => p.sku)).toEqual(['RV-GRAVEL']);
    });

    it('counts only its own rows', async () => {
      const counts = await withTenant(orgA.organizationId, async (tx) => ({
        customers: await tx.customer.count(),
        products: await tx.product.count(),
      }));
      expect(counts).toEqual({ customers: 1, products: 1 });
    });

    it('cannot reach another organization through a search filter', async () => {
      const listed = await withTenant(orgA.organizationId, (tx) =>
        listCustomers(tx, { search: 'Adama' }),
      );
      expect(listed).toEqual([]);
    });
  });

  describe('writes', () => {
    it('stamps a created row with the acting organization', async () => {
      const created = await withTenant(orgA.organizationId, (tx) =>
        createCustomer(tx, orgA.context, { companyName: 'Horizon Contractors' }, 'ETB'),
      );
      expect(created.ok).toBe(true);

      const fromB = await withTenant(orgB.organizationId, (tx) =>
        listCustomers(tx, { search: 'Horizon' }),
      );
      expect(fromB).toEqual([]);
    });

    it('cannot update another organization row', async () => {
      const affected = await withTenant(orgA.organizationId, (tx) =>
        tx.customer.updateMany({ where: { id: customerB }, data: { companyName: 'Hijacked' } }),
      );
      expect(affected.count).toBe(0);

      const untouched = await owner.customer.findUnique({ where: { id: customerB } });
      expect(untouched?.companyName).toBe('Adama Roads Authority');
    });

    it('cannot delete another organization row', async () => {
      const affected = await withTenant(orgA.organizationId, (tx) =>
        tx.customer.deleteMany({ where: { id: customerB } }),
      );
      expect(affected.count).toBe(0);
      expect(await owner.customer.findUnique({ where: { id: customerB } })).not.toBeNull();
    });

    it('cannot adjust stock on another organization product', async () => {
      const result = await withTenant(orgA.organizationId, (tx) =>
        adjustStock(tx, orgA.context, productB, { delta: -100, reason: 'attempted' }),
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');

      const untouched = await owner.product.findUnique({ where: { id: productB } });
      expect(untouched?.availableStock).toBe(900);
    });
  });

  describe('explicit cross-tenant attempts', () => {
    it('throws rather than silently rewriting a foreign organization filter', async () => {
      await expect(
        withTenant(orgA.organizationId, (tx) =>
          tx.customer.findMany({ where: { organizationId: orgB.organizationId } }),
        ),
      ).rejects.toBeInstanceOf(CrossTenantAccessError);
    });

    it('throws when a create names a foreign organization', async () => {
      await expect(
        withTenant(orgA.organizationId, (tx) =>
          tx.customer.create({
            data: { organizationId: orgB.organizationId, companyName: 'Smuggled' },
          }),
        ),
      ).rejects.toBeInstanceOf(CrossTenantAccessError);
    });
  });

  describe('the audit log', () => {
    it('is scoped like everything else', async () => {
      await withTenant(orgB.organizationId, (tx) =>
        createCustomer(tx, orgB.context, { companyName: 'Second B Customer' }, 'ETB'),
      );

      const fromA = await withTenant(orgA.organizationId, (tx) => recentAudit(tx));
      const fromB = await withTenant(orgB.organizationId, (tx) => recentAudit(tx));

      expect(fromA.length).toBeGreaterThan(0);
      expect(fromB.length).toBeGreaterThan(0);
      // Sequences are per-organization, so both start at 1 and neither sees the other.
      expect(fromA.every((e) => e.entityType === 'customer')).toBe(true);
      const aIds = new Set(fromA.map((e) => e.id));
      expect(fromB.some((e) => aIds.has(e.id))).toBe(false);
    });
  });

  describe('row-level security underneath', () => {
    it('returns nothing when no organization has been set', async () => {
      // The client extension is bypassed here on purpose, to prove that layer 2 stands on its
      // own: outside withTenant() there is no app.organization_id, so the policy hides
      // everything. It must return *no rows*, not raise — on a pooled connection that has
      // already served a scoped transaction the setting reverts to '' rather than unset, and
      // an unguarded ''::uuid cast would error instead. See the rls_empty_setting migration.
      const unscopedRows = await tenantClient(orgA.organizationId).$queryRawUnsafe<
        { count: bigint }[]
      >('SELECT count(*)::bigint AS count FROM customers');
      expect(Number(unscopedRows[0]?.count)).toBe(0);
    });

    it('returns nothing on a connection that previously served another tenant', async () => {
      // The regression this pins: run a scoped transaction first, so the pooled connection
      // leaves app.organization_id as an empty string, then query unscoped on it.
      await withTenant(orgB.organizationId, (tx) => tx.customer.count());

      const rows = await tenantClient(orgA.organizationId).$queryRawUnsafe<{ count: bigint }[]>(
        'SELECT count(*)::bigint AS count FROM customers',
      );
      expect(Number(rows[0]?.count)).toBe(0);
    });

    it('shows only the current organization inside a scoped transaction', async () => {
      const rows = await withTenant(orgA.organizationId, (tx) =>
        tx.$queryRawUnsafe<{ count: bigint }[]>('SELECT count(*)::bigint AS count FROM customers'),
      );
      const ownerCount = await owner.customer.count();
      expect(Number(rows[0]?.count)).toBeLessThan(ownerCount);
      expect(Number(rows[0]?.count)).toBe(
        await owner.customer.count({ where: { organizationId: orgA.organizationId } }),
      );
    });
  });

  // Kept last: it truncates, so anything after it would run against an empty database.
  describe('cleanup', () => {
    beforeEach(async () => {
      await resetDatabase();
    });

    it('leaves no rows behind', async () => {
      expect(await owner.customer.count()).toBe(0);
    });
  });
});
