import { withTenant } from '@/platform/db';
import { confirmPayment, submitPayment } from '@/modules/payments';
import type { ActorContext } from '@/platform/context';
import { owner } from './fixtures';
import { openOrder } from './payment-fixtures';

/**
 * Builds an order that has genuinely cleared its gate.
 *
 * A cash order is walked through the real Phase 5 submission and confirmation rather than
 * having `paymentStatus` written directly, because "READY was reached by a confirmed payment"
 * is precisely the property Phase 6 depends on. A test that stamped the column would pass
 * against a build where the gate had been removed.
 */
export async function fulfillableOrder(
  organizationId: string,
  context: ActorContext,
  options: {
    paymentType?: 'CASH' | 'CREDIT';
    deliveryRequired?: boolean;
    companyName?: string;
    message?: string;
    paymentTermsDays?: number;
    /** Stop before paying, to test that an unpaid cash order is refused. */
    leaveUnpaid?: boolean;
    /** Pay part of it, to test that a partly paid cash order is refused. */
    payFraction?: number;
  } = {},
): Promise<{
  orderId: string;
  orderNumber: string;
  grandTotalMinor: bigint;
  customerId: string;
}> {
  const paymentType = options.paymentType ?? 'CASH';

  const order = await openOrder(organizationId, context, {
    paymentType,
    companyName: options.companyName,
    message: options.message,
    paymentTermsDays: options.paymentTermsDays,
  });

  if (options.deliveryRequired) {
    await owner.salesOrder.update({
      where: { id: order.orderId },
      data: { deliveryRequired: true, deliveryAddressSnapshot: 'Bole Bulbula, Addis Ababa' },
    });
  }

  if (paymentType === 'CASH' && !options.leaveUnpaid) {
    const fraction = options.payFraction ?? 1;
    const amountMinor =
      fraction >= 1
        ? order.grandTotalMinor
        : (order.grandTotalMinor * BigInt(Math.round(fraction * 100))) / 100n;

    const submitted = await withTenant(organizationId, (tx) =>
      submitPayment(tx, context, {
        salesOrderId: order.orderId,
        amountClaimed: decimalOf(amountMinor),
        method: 'BANK_TRANSFER',
        transactionReference: `FT-FULFIL-${order.orderNumber}`,
      }),
    );
    if (!submitted.ok) throw new Error(`payment submission failed: ${submitted.error.message}`);

    const confirmed = await withTenant(organizationId, (tx) =>
      confirmPayment(tx, context, submitted.value.id),
    );
    if (!confirmed.ok) throw new Error(`payment confirmation failed: ${confirmed.error.message}`);
  }

  return order;
}

export function decimalOf(minor: bigint): string {
  const absolute = minor < 0n ? -minor : minor;
  return `${minor < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

/**
 * The stock invariant Phase 4 established and Phase 6 must not break.
 *
 * `product.reserved_stock` is a maintained cache of the ACTIVE reservation rows. Asserted after
 * every operation that touches either, because a fulfilment bug shows up here first.
 */
export async function assertStockInvariants(organizationId: string): Promise<void> {
  const products = await owner.product.findMany({ where: { organizationId } });

  for (const product of products) {
    const active = await owner.stockReservation.aggregate({
      where: { organizationId, productId: product.id, status: 'ACTIVE' },
      _sum: { quantity: true },
    });

    if (product.reservedStock !== (active._sum.quantity ?? 0)) {
      throw new Error(
        `${product.sku}: reserved_stock is ${product.reservedStock}, ACTIVE reservations sum to ${active._sum.quantity ?? 0}`,
      );
    }
    if (product.availableStock < product.reservedStock) {
      throw new Error(
        `${product.sku}: available_stock ${product.availableStock} is below reserved_stock ${product.reservedStock}`,
      );
    }
    if (product.availableStock < 0) {
      throw new Error(`${product.sku}: available_stock went negative (${product.availableStock})`);
    }
  }
}

/** The stock figures for a product, by SKU. */
export async function stockOf(
  organizationId: string,
  sku: string,
): Promise<{ availableStock: number; reservedStock: number }> {
  const product = await owner.product.findFirstOrThrow({ where: { organizationId, sku } });
  return { availableStock: product.availableStock, reservedStock: product.reservedStock };
}
