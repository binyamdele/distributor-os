/**
 * Demo data for a construction-material distributor in Addis Ababa.
 *
 * Everything here is SYNTHETIC. The prices are plausible round numbers chosen to make the
 * arithmetic legible in a demo; they are not market prices and must never be presented as
 * such. The customers and their credit standings are invented.
 *
 * Two organizations are seeded on purpose. "Rift Valley Trading PLC" exists so that a tenancy
 * leak is visible — to the isolation tests, and to anyone who opens the app and sees a company
 * that should not be there.
 *
 * The seed connects as the owner (DIRECT_URL) rather than the application role, because RLS
 * would otherwise — correctly — refuse writes made outside a tenant-scoped transaction.
 */
import { config as loadEnv } from 'dotenv';
import { PrismaClient, type Prisma } from '@prisma/client';
import { hashPassword } from '../src/platform/security/passwords';
import { normalizeAlias } from '../src/modules/catalog/normalize';

loadEnv();

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DIRECT_URL or DATABASE_URL must be set to seed.');

const prisma = new PrismaClient({ datasources: { db: { url } } });

/** Stable ids, so re-seeding updates the same rows and demo links keep working. */
const ADDIS = '0f8fad5b-d9cb-469f-a165-70867728950e';
const RIFT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const DEMO_PASSWORD = 'DemoPassword2026';

/** ETB minor units (santim). 1_250_00 santim = ETB 1,250.00 */
const etb = (major: number, minor = 0): bigint => BigInt(major) * 100n + BigInt(minor);

interface SeedUser {
  email: string;
  fullName: string;
  role: 'OWNER_ADMIN' | 'SALES_MANAGER' | 'SALESPERSON' | 'FINANCE' | 'WAREHOUSE';
}

const ADDIS_USERS: SeedUser[] = [
  { email: 'owner@addisbuild.example', fullName: 'Selamawit Bekele', role: 'OWNER_ADMIN' },
  { email: 'manager@addisbuild.example', fullName: 'Dawit Haile', role: 'SALES_MANAGER' },
  { email: 'sales@addisbuild.example', fullName: 'Meron Tesfaye', role: 'SALESPERSON' },
  { email: 'finance@addisbuild.example', fullName: 'Yonas Girma', role: 'FINANCE' },
  { email: 'warehouse@addisbuild.example', fullName: 'Abebe Kebede', role: 'WAREHOUSE' },
];

const RIFT_USERS: SeedUser[] = [
  { email: 'owner@riftvalley.example', fullName: 'Hanna Mekonnen', role: 'OWNER_ADMIN' },
];

const ADDIS_CUSTOMERS = [
  {
    companyName: 'ABC Construction PLC',
    contactName: 'Tewodros Alemu',
    phone: '+251911000101',
    email: 'procurement@abc-construction.example',
    address: 'Bole Bulbula, Addis Ababa',
    creditStatus: 'CREDIT_ALLOWED' as const,
    creditLimitMinor: etb(2_000_000),
    paymentTermsDays: 30,
    preferredLanguage: 'en',
  },
  {
    companyName: 'XYZ Trading',
    contactName: 'Frehiwot Assefa',
    phone: '+251911000102',
    email: 'buy@xyztrading.example',
    address: 'Merkato, Addis Ababa',
    creditStatus: 'CREDIT_ALLOWED' as const,
    creditLimitMinor: etb(750_000),
    paymentTermsDays: 15,
    preferredLanguage: 'am',
  },
  {
    companyName: 'Horizon Contractors',
    contactName: 'Bereket Solomon',
    phone: '+251911000103',
    email: 'ops@horizon-contractors.example',
    address: 'Ayat, Addis Ababa',
    creditStatus: 'CASH_ONLY' as const,
    creditLimitMinor: 0n,
    paymentTermsDays: 0,
    preferredLanguage: 'en',
  },
  {
    companyName: 'East Africa Engineering',
    contactName: 'Rahel Girmay',
    phone: '+251911000104',
    email: 'supply@ea-engineering.example',
    address: 'Kality, Addis Ababa',
    // Suspended on purpose: Phase 3's approval rules must block a credit order for this one.
    creditStatus: 'SUSPENDED' as const,
    creditLimitMinor: etb(1_200_000),
    paymentTermsDays: 30,
    preferredLanguage: 'en',
  },
];

interface SeedProduct {
  sku: string;
  name: string;
  category: string;
  unit: string;
  priceMinor: bigint;
  availableStock: number;
  reorderThreshold: number;
  aliases: string[];
}

const ADDIS_PRODUCTS: SeedProduct[] = [
  {
    sku: 'CEM-OPC-50',
    name: 'OPC Cement 50kg',
    category: 'Cement',
    unit: 'bag',
    priceMinor: etb(1_250),
    availableStock: 4_800,
    reorderThreshold: 1_000,
    aliases: ['OPC cement', 'cement', 'OPC', 'ordinary portland cement', '50kg cement', 'ስሚንቶ'],
  },
  {
    sku: 'RB-08',
    name: 'Rebar 8mm',
    category: 'Reinforcement',
    unit: 'piece',
    priceMinor: etb(640),
    availableStock: 1_900,
    reorderThreshold: 400,
    aliases: ['8mm', '8 mm', '8mm rebar', '8 fer', 'rebar 8', 'ብረት 8'],
  },
  {
    sku: 'RB-10',
    name: 'Rebar 10mm',
    category: 'Reinforcement',
    unit: 'piece',
    priceMinor: etb(985),
    availableStock: 2_400,
    reorderThreshold: 500,
    aliases: ['10mm', '10 mm', '10mm rebar', '10 fer', 'rebar 10'],
  },
  {
    sku: 'RB-12',
    name: 'Rebar 12mm',
    category: 'Reinforcement',
    unit: 'piece',
    priceMinor: etb(1_420),
    // Just above its threshold: healthy, but the next large order tips it over.
    availableStock: 620,
    reorderThreshold: 600,
    aliases: ['12mm', '12 mm', '12mm rebar', '12 mm steel', '12 fer', 'rebar 12'],
  },
  {
    sku: 'RB-16',
    name: 'Rebar 16mm',
    category: 'Reinforcement',
    unit: 'piece',
    priceMinor: etb(2_510),
    // Below its reorder threshold on purpose, so the low-stock indicator and the dashboard
    // count have something real to show. 16mm is the size a distributor most often runs short of.
    availableStock: 240,
    reorderThreshold: 250,
    aliases: ['16mm', '16 mm', '16mm rebar', '16 fer', 'rebar 16'],
  },
  {
    sku: 'HB-20',
    name: 'Hollow Block 20cm',
    category: 'Masonry',
    unit: 'piece',
    priceMinor: etb(42),
    availableStock: 15_000,
    reorderThreshold: 3_000,
    aliases: ['hollow block', 'HCB', '20cm block', 'block 20', 'ሆሎ ብሎክ'],
  },
];

/** A distinct catalogue for the second tenant, so a leak is unmistakable. */
const RIFT_PRODUCTS: SeedProduct[] = [
  {
    sku: 'RV-GRAVEL',
    name: 'Crushed Gravel 3/4"',
    category: 'Aggregate',
    unit: 'm3',
    priceMinor: etb(1_850),
    availableStock: 900,
    reorderThreshold: 200,
    aliases: ['gravel', 'crushed stone', '3/4 gravel'],
  },
];

const auditSequence = new Map<string, bigint>();

async function recordSeedAudit(
  organizationId: string,
  action: string,
  entityType: string,
  entityId: string,
  newState: Prisma.InputJsonValue,
): Promise<void> {
  const next = (auditSequence.get(organizationId) ?? 0n) + 1n;
  auditSequence.set(organizationId, next);
  await prisma.auditEvent.create({
    data: {
      organizationId,
      sequence: next,
      actorType: 'SYSTEM',
      action,
      entityType,
      entityId,
      newState,
      source: 'seed',
    },
  });
}

async function seedOrganization(
  id: string,
  name: string,
  users: SeedUser[],
  customers: typeof ADDIS_CUSTOMERS,
  products: SeedProduct[],
  passwordHash: string,
): Promise<void> {
  await prisma.organization.upsert({
    where: { id },
    update: { name },
    create: { id, name, currency: 'ETB', timezone: 'Africa/Addis_Ababa', vatRateBp: 1500 },
  });

  await prisma.organizationSettings.upsert({
    where: { organizationId: id },
    update: {},
    create: { organizationId: id },
  });

  for (const kind of ['QUOTATION', 'ORDER'] as const) {
    await prisma.numberSequence.upsert({
      where: { organizationId_kind: { organizationId: id, kind } },
      update: {},
      create: { organizationId: id, kind },
    });
  }

  for (const seedUser of users) {
    const user = await prisma.user.upsert({
      where: { email: seedUser.email },
      update: { fullName: seedUser.fullName },
      create: {
        email: seedUser.email,
        fullName: seedUser.fullName,
        passwordHash,
        locale: 'en',
      },
    });
    await prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: id, userId: user.id } },
      update: { role: seedUser.role },
      create: { organizationId: id, userId: user.id, role: seedUser.role },
    });
  }

  for (const customer of customers) {
    const existing = await prisma.customer.findFirst({
      where: { organizationId: id, companyName: customer.companyName },
    });
    const record = existing
      ? await prisma.customer.update({ where: { id: existing.id }, data: customer })
      : await prisma.customer.create({ data: { ...customer, organizationId: id } });

    if (!existing) {
      await recordSeedAudit(id, 'customer.created', 'customer', record.id, {
        companyName: record.companyName,
        creditStatus: record.creditStatus,
      });
    }
  }

  for (const product of products) {
    const record = await prisma.product.upsert({
      where: { organizationId_sku: { organizationId: id, sku: product.sku } },
      update: {
        name: product.name,
        category: product.category,
        unit: product.unit,
        sellingPriceMinor: product.priceMinor,
        availableStock: product.availableStock,
        reorderThreshold: product.reorderThreshold,
      },
      create: {
        organizationId: id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        unit: product.unit,
        sellingPriceMinor: product.priceMinor,
        taxRateBp: 1500,
        availableStock: product.availableStock,
        reorderThreshold: product.reorderThreshold,
      },
    });

    for (const alias of product.aliases) {
      const normalizedAlias = normalizeAlias(alias);
      await prisma.productAlias.upsert({
        where: { organizationId_normalizedAlias: { organizationId: id, normalizedAlias } },
        update: { productId: record.id, alias },
        create: {
          organizationId: id,
          productId: record.id,
          alias,
          normalizedAlias,
          source: 'SEED',
        },
      });
    }

    await recordSeedAudit(id, 'product.created', 'product', record.id, {
      sku: record.sku,
      name: record.name,
      availableStock: record.availableStock,
    });
  }
}

async function main(): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // Re-seeding continues the audit sequence rather than restarting it.
  for (const organizationId of [ADDIS, RIFT]) {
    const highest = await prisma.auditEvent.aggregate({
      where: { organizationId },
      _max: { sequence: true },
    });
    auditSequence.set(organizationId, highest._max.sequence ?? 0n);
  }

  await seedOrganization(
    ADDIS,
    'Addis Build Supply PLC',
    ADDIS_USERS,
    ADDIS_CUSTOMERS,
    ADDIS_PRODUCTS,
    passwordHash,
  );

  await seedOrganization(
    RIFT,
    'Rift Valley Trading PLC',
    RIFT_USERS,
    [
      {
        companyName: 'Adama Roads Authority',
        contactName: 'Kalkidan Worku',
        phone: '+251911000201',
        email: 'tender@adama-roads.example',
        address: 'Adama',
        creditStatus: 'CREDIT_ALLOWED' as const,
        creditLimitMinor: etb(500_000),
        paymentTermsDays: 45,
        preferredLanguage: 'am',
      },
    ],
    RIFT_PRODUCTS,
    passwordHash,
  );

  console.log('Seeded 2 organizations.');
  console.log(`  Addis Build Supply PLC — ${ADDIS_USERS.length} users, ${ADDIS_CUSTOMERS.length} customers, ${ADDIS_PRODUCTS.length} products`);
  console.log(`  Rift Valley Trading PLC — tenancy canary, ${RIFT_PRODUCTS.length} product`);
  console.log('');
  console.log(`Demo sign-in (synthetic data, not real prices): password "${DEMO_PASSWORD}"`);
  for (const user of ADDIS_USERS) console.log(`  ${user.role.padEnd(14)} ${user.email}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
