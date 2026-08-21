import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '@/platform/security';
import type { ActorContext } from '@/platform/context';
import type { Role } from '@/platform/rbac';

/**
 * Test fixtures.
 *
 * Setup connects as the *owner* role, deliberately. The tests need to plant rows in two
 * organizations in order to prove that the application role cannot see across them — which
 * would be impossible if the fixture builder were itself subject to the policy it is testing.
 * Every assertion afterwards goes through the ordinary application path.
 */
const ownerUrl = process.env.TEST_DIRECT_URL ?? process.env.DIRECT_URL;

export const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

/** Tables emptied between test files, children before parents. */
const TABLES = [
  'payments',
  'payment_evidence_files',
  'stock_reservations',
  'sales_order_items',
  'sales_orders',
  'quotation_follow_ups',
  'quotation_approvals',
  'quotation_items',
  'quotations',
  'ai_interactions',
  'inquiry_item_proposals',
  'inquiries',
  'audit_events',
  'stock_adjustments',
  'product_aliases',
  'products',
  'customers',
  'sessions',
  'memberships',
  'number_sequences',
  'organization_settings',
  'users',
  'organizations',
];

export async function resetDatabase(): Promise<void> {
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export interface SeededOrg {
  organizationId: string;
  userId: string;
  context: ActorContext;
}

export async function seedOrg(name: string, role: Role = 'OWNER_ADMIN'): Promise<SeededOrg> {
  const organization = await owner.organization.create({
    data: { name, currency: 'ETB' },
  });

  const user = await owner.user.create({
    data: {
      // Globally unique rather than counter-based: two test files seeding the same company
      // name would otherwise generate the same address and collide on the unique index.
      email: `user-${randomUUID()}@${name.toLowerCase().replace(/\W+/g, '')}.example`,
      fullName: `Test User (${name})`,
      passwordHash: await hashPassword('IntegrationTestPassword1'),
    },
  });

  await owner.membership.create({
    data: { organizationId: organization.id, userId: user.id, role },
  });

  await owner.organizationSettings.create({ data: { organizationId: organization.id } });

  return {
    organizationId: organization.id,
    userId: user.id,
    context: {
      organizationId: organization.id,
      userId: user.id,
      role,
      source: 'test',
    },
  };
}

export async function seedCustomer(organizationId: string, companyName: string): Promise<string> {
  const customer = await owner.customer.create({
    data: { organizationId, companyName },
  });
  return customer.id;
}

export async function seedProduct(
  organizationId: string,
  sku: string,
  options: { availableStock?: number; priceMinor?: bigint } = {},
): Promise<string> {
  const product = await owner.product.create({
    data: {
      organizationId,
      sku,
      name: `Product ${sku}`,
      unit: 'piece',
      sellingPriceMinor: options.priceMinor ?? 100_00n,
      availableStock: options.availableStock ?? 100,
    },
  });
  return product.id;
}
