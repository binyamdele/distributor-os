/**
 * Volume data for reporting performance work.
 *
 * Not part of the demo seed and not run by default — `pnpm seed:volume` loads it into a throwaway
 * organization so the dashboard can be measured against something bigger than a hand-built
 * scenario. Everything is synthetic.
 *
 * The point is not to prove the product scales to a large distributor; it is to catch the
 * specific mistake this phase could make, which is a query per card or a scan where an index
 * should be. A few thousand rows is enough for a sequential scan to show up in a plan and in the
 * wall clock, and small enough to load in seconds.
 *
 * Rows are inserted through `createMany` rather than the domain modules, deliberately: this data
 * exists to be counted, not to be correct in every workflow sense, and driving thousands of
 * orders through the real state machines would take minutes and prove nothing extra about
 * reporting.
 */
import { config as loadEnv } from 'dotenv';
import { guardDatabaseTarget, guardDestructive } from './guard';
import { PrismaClient } from '@prisma/client';

loadEnv();

guardDestructive('volume seed');
guardDatabaseTarget('volume seed');

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DIRECT_URL or DATABASE_URL must be set.');

const prisma = new PrismaClient({ datasources: { db: { url } } });

/** A stable id, so re-running replaces rather than accumulates. */
const VOLUME_ORG = '11111111-2222-4333-8444-555555555555';

const QUOTATIONS = 4_000;
const ORDERS = 800;
const PAYMENTS = 600;
const CUSTOMERS = 60;
const PRODUCTS = 40;
const DAYS_OF_HISTORY = 90;

function daysAgo(days: number, hourOffset = 9): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hourOffset, 0, 0, 0);
  return date;
}

async function main() {
  console.log('Clearing any previous volume organization…');
  await prisma.organization.deleteMany({ where: { id: VOLUME_ORG } });
  await prisma.user.deleteMany({ where: { email: 'volume@synthetic.invalid' } });

  await prisma.organization.create({
    data: {
      id: VOLUME_ORG,
      name: 'Volume Test Distributor (synthetic)',
      currency: 'ETB',
      timezone: 'Africa/Addis_Ababa',
    },
  });

  console.log(`Seeding ${CUSTOMERS} customers and ${PRODUCTS} products…`);
  await prisma.customer.createMany({
    data: Array.from({ length: CUSTOMERS }, (_, index) => ({
      organizationId: VOLUME_ORG,
      companyName: `Synthetic Customer ${index + 1}`,
      creditStatus: index % 3 === 0 ? ('CASH_ONLY' as const) : ('CREDIT_ALLOWED' as const),
      creditLimitMinor: 1_000_000_00n,
      paymentTermsDays: 30,
    })),
  });

  await prisma.product.createMany({
    data: Array.from({ length: PRODUCTS }, (_, index) => ({
      organizationId: VOLUME_ORG,
      sku: `VOL-${String(index + 1).padStart(4, '0')}`,
      name: `Synthetic Product ${index + 1}`,
      unit: 'unit',
      sellingPriceMinor: BigInt((index + 1) * 1_000) * 100n,
      availableStock: 500 + index * 10,
      reservedStock: 0,
      // A tenth of the catalogue is low, so the low-stock count has something to find.
      reorderThreshold: index % 10 === 0 ? 600 + index * 10 : 50,
    })),
  });

  const customers = await prisma.customer.findMany({
    where: { organizationId: VOLUME_ORG },
    select: { id: true },
  });

  console.log(`Seeding ${QUOTATIONS} quotations across ${DAYS_OF_HISTORY} days…`);
  await prisma.quotation.createMany({
    data: Array.from({ length: QUOTATIONS }, (_, index) => {
      const age = index % DAYS_OF_HISTORY;
      const createdAt = daysAgo(age, 8 + (index % 10));
      // A third accepted, a sixth rejected, the rest still out — enough of each for the
      // acceptance rate and the pipeline counts to be non-trivial.
      const accepted = index % 3 === 0;
      const rejected = !accepted && index % 6 === 0;

      return {
        organizationId: VOLUME_ORG,
        quotationNumber: `VQ-${String(index + 1).padStart(6, '0')}`,
        customerId: customers[index % customers.length]!.id,
        status: accepted ? ('ACCEPTED' as const) : rejected ? ('REJECTED' as const) : ('SENT' as const),
        currency: 'ETB',
        paymentType: 'CASH' as const,
        paymentTermsDays: 0,
        validityDate: createdAt,
        subtotalMinor: BigInt(50_000 + index * 7) * 100n,
        discountTotalMinor: 0n,
        deliveryFeeMinor: 0n,
        deliveryTaxMinor: 0n,
        taxTotalMinor: BigInt(Math.round((50_000 + index * 7) * 0.15)) * 100n,
        grandTotalMinor: BigInt(Math.round((50_000 + index * 7) * 1.15)) * 100n,
        createdAt,
        sentAt: createdAt,
        acceptedAt: accepted ? createdAt : null,
        rejectedAt: rejected ? createdAt : null,
        // Required by the schema. A synthetic value, and never approved against, so it cannot
        // be mistaken for a real approval fingerprint.
        currentPayloadHash: `volume-quotation-${index}`,
      };
    }),
  });

  const acceptedQuotations = await prisma.quotation.findMany({
    where: { organizationId: VOLUME_ORG, status: 'ACCEPTED' },
    select: { id: true, customerId: true, grandTotalMinor: true, createdAt: true },
    take: ORDERS,
  });

  console.log(`Seeding ${acceptedQuotations.length} sales orders…`);
  await prisma.salesOrder.createMany({
    data: acceptedQuotations.map((quotation, index) => {
      const dueDate = new Date(quotation.createdAt);
      dueDate.setUTCDate(dueDate.getUTCDate() + 30);
      dueDate.setUTCHours(0, 0, 0, 0);

      return {
        organizationId: VOLUME_ORG,
        orderNumber: `VSO-${String(index + 1).padStart(6, '0')}`,
        quotationId: quotation.id,
        customerId: quotation.customerId,
        status: 'OPEN' as const,
        paymentStatus: 'NOT_REQUIRED_YET' as const,
        fulfillmentStatus: 'READY' as const,
        currency: 'ETB',
        paymentType: 'CREDIT' as const,
        paymentTermsDays: 30,
        paymentDueDate: dueDate,
        subtotalMinor: quotation.grandTotalMinor,
        discountTotalMinor: 0n,
        deliveryFeeMinor: 0n,
        deliveryTaxMinor: 0n,
        taxTotalMinor: 0n,
        grandTotalMinor: quotation.grandTotalMinor,
        createdAt: quotation.createdAt,
      };
    }),
  });

  // Payments record who submitted the claim, so the volume set needs a user to attribute to.
  const volumeUser = await prisma.user.create({
    data: {
      email: 'volume@synthetic.invalid',
      fullName: 'Volume Test User',
      passwordHash: 'not-a-real-hash-volume-data-only',
    },
  });
  await prisma.membership.create({
    data: { organizationId: VOLUME_ORG, userId: volumeUser.id, role: 'OWNER_ADMIN' },
  });

  const orders = await prisma.salesOrder.findMany({
    where: { organizationId: VOLUME_ORG },
    select: { id: true, customerId: true, grandTotalMinor: true, createdAt: true },
    take: PAYMENTS,
  });

  console.log(`Seeding ${orders.length} confirmed payments…`);
  await prisma.payment.createMany({
    data: orders.map((order, index) => ({
      organizationId: VOLUME_ORG,
      salesOrderId: order.id,
      customerId: order.customerId,
      status: 'CONFIRMED' as const,
      method: 'BANK_TRANSFER' as const,
      currency: 'ETB',
      // Half settle fully, half partly, so the receivables arithmetic has real work to do.
      amountClaimedMinor: index % 2 === 0 ? order.grandTotalMinor : order.grandTotalMinor / 2n,
      amountConfirmedMinor: index % 2 === 0 ? order.grandTotalMinor : order.grandTotalMinor / 2n,
      confirmationPayloadHash: `volume-${index}`,
      submittedById: volumeUser.id,
      createdAt: order.createdAt,
      reviewedAt: order.createdAt,
    })),
  });

  const counts = {
    quotations: await prisma.quotation.count({ where: { organizationId: VOLUME_ORG } }),
    orders: await prisma.salesOrder.count({ where: { organizationId: VOLUME_ORG } }),
    payments: await prisma.payment.count({ where: { organizationId: VOLUME_ORG } }),
  };

  console.log('');
  console.log('Volume organization seeded (synthetic).');
  console.log(`  id          ${VOLUME_ORG}`);
  console.log(`  quotations  ${counts.quotations}`);
  console.log(`  orders      ${counts.orders}`);
  console.log(`  payments    ${counts.payments}`);
  console.log('');
  console.log('Measure with: pnpm vitest run --project integration tests/integration/dashboard-performance.test.ts');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
