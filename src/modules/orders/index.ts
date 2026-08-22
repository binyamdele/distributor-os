import 'server-only';
import { z } from 'zod';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { isUuid } from '@/platform/ids';
import { type Result, fail, ok } from '@/platform/result';
import { recordAudit } from '@/modules/audit';
import { allocateDocumentNumber } from '@/modules/numbering';
import {
  type LineShortfall,
  type ProductStock,
  type ReservationRequest,
  lockOrder,
  planReservation,
} from './reservation';

export * from './reservation';

/**
 * Sales orders.
 *
 * An order is the accepted quotation made operational. Its commercial figures are *copied* from
 * the quotation's snapshots, santim for santim — no live catalogue price, no current VAT rate,
 * no re-run of the discount policy, no model. The agreement was settled when the customer
 * accepted; re-deriving any part of it would change what they agreed to.
 *
 * What is *not* settled at acceptance is stock. Between sending a quotation and hearing back,
 * the yard changes. That is why reservation happens here and can fail here, and why a failure
 * leaves the quotation untouched as historical truth.
 */

export const ORDER_STATUSES = ['OPEN', 'CANCELLED', 'COMPLETED'] as const;
export type SalesOrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * `PARTIALLY_PAID` was added in Phase 5, when confirmed payments became real.
 *
 * A part-settled order is neither of the other two, and collapsing it into either misleads:
 * UNPAID hides money that genuinely arrived, PAID would release goods that are not paid for.
 * The Phase 4 rule that a cash order *starts* UNPAID and NOT_READY is unchanged.
 */
export const PAYMENT_STATUSES = [
  'UNPAID',
  'PARTIALLY_PAID',
  'NOT_REQUIRED_YET',
  'PAID',
] as const;
export type OrderPaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FULFILLMENT_STATUSES = ['NOT_READY', 'READY', 'CANCELLED'] as const;
export type OrderFulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

/**
 * The initial payment and fulfilment position, decided from the accepted terms.
 *
 * The load-bearing case is cash. Reserving stock must **not** imply the warehouse may release
 * goods: for a cash order the money has not arrived, and unlocking fulfilment is Phase 5's job
 * once finance confirms a payment. A credit order is different — the customer has already been
 * granted terms, so nothing is owed yet and preparation may begin.
 *
 * Neither creates a warehouse task. That is Phase 6.
 */
export function initialStatuses(paymentType: 'CASH' | 'CREDIT'): {
  paymentStatus: OrderPaymentStatus;
  fulfillmentStatus: OrderFulfillmentStatus;
} {
  return paymentType === 'CASH'
    ? { paymentStatus: 'UNPAID', fulfillmentStatus: 'NOT_READY' }
    : { paymentStatus: 'NOT_REQUIRED_YET', fulfillmentStatus: 'READY' };
}

function addDays(base: Date, days: number): Date {
  const result = new Date(base.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export const createOrderSchema = z.object({
  quotationId: z.string().uuid(),
  deliveryRequired: z.coerce.boolean().default(false),
});

export interface CreatedOrder {
  readonly id: string;
  readonly orderNumber: string;
  /** True when an order already existed for this quotation and was returned instead. */
  readonly alreadyExisted: boolean;
}

/**
 * Converts an accepted quotation into a sales order, reserving stock atomically.
 *
 * The sequence inside one transaction:
 *
 *   1. lock the product rows, in ascending id order
 *   2. load the accepted quotation
 *   3. refuse if an active order already exists for it
 *   4. check the acceptance invariants
 *   5. plan the reservation; refuse in full if any line is short
 *   6. create the order, its items and the reservation rows
 *   7. raise the aggregate on each product
 *   8. audit
 *
 * Products are locked *before* the quotation is read, so the availability figures cannot move
 * between being checked and being committed against.
 */
export async function createFromQuotation(
  tx: TenantTransaction,
  context: ActorContext,
  raw: unknown,
): Promise<Result<CreatedOrder>> {
  const parsed = createOrderSchema.safeParse(raw);
  if (!parsed.success) return fail('VALIDATION_FAILED', 'error.generic');

  const quotation = await tx.quotation.findFirst({
    where: { id: parsed.data.quotationId },
    include: {
      customer: true,
      items: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!quotation) return fail('NOT_FOUND', 'error.notFound');

  if (quotation.status !== 'ACCEPTED') {
    return fail(
      'INVALID_STATE_TRANSITION',
      `Only an accepted quotation becomes a sales order; ${quotation.quotationNumber} is ${quotation.status
        .toLowerCase()
        .replace(/_/g, ' ')}.`,
    );
  }

  // Idempotency, first line of defence. The partial unique index is the second, and the one
  // that actually holds when two requests arrive together.
  const existing = await tx.salesOrder.findFirst({
    where: { quotationId: quotation.id, status: { not: 'CANCELLED' } },
  });
  if (existing) {
    return ok({
      id: existing.id,
      orderNumber: existing.orderNumber,
      alreadyExisted: true,
    });
  }

  // --- lock every product this order will touch, in a deterministic order ---
  const productIds = lockOrder(
    quotation.items.map((item) => item.productId).filter((id): id is string => id !== null),
  );

  if (productIds.length !== quotation.items.length) {
    return fail(
      'CONFLICT',
      'A product on this quotation is no longer in the catalogue, so stock cannot be reserved for it.',
    );
  }

  for (const productId of productIds) {
    // One statement per id, in sorted order. A single ORDER BY ... FOR UPDATE would usually
    // lock in the same sequence, but "usually" is not a property to rest a deadlock guarantee on.
    await tx.$executeRaw`
      SELECT id FROM products
       WHERE id = ${productId}::uuid
         AND organization_id = ${context.organizationId}::uuid
       FOR UPDATE
    `;
  }

  const products = await tx.product.findMany({ where: { id: { in: productIds } } });
  const stocks: ProductStock[] = products.map((product) => ({
    productId: product.id,
    availableStock: product.availableStock,
    reservedStock: product.reservedStock,
  }));

  const requests: ReservationRequest[] = quotation.items.map((item) => ({
    productId: item.productId!,
    sku: item.skuSnapshot,
    description: item.descriptionSnapshot,
    unit: item.unitSnapshot,
    quantity: item.quantity,
  }));

  const plan = planReservation(requests, stocks);

  if (!plan.satisfiable) {
    // A refusal worth recording: "we lost this order because the yard was empty" is exactly the
    // sort of thing a distributor wants to be able to count later.
    await recordAudit(tx, context, {
      action: 'order.creation_refused_insufficient_stock',
      entityType: 'quotation',
      entityId: quotation.id,
      newState: {
        quotationNumber: quotation.quotationNumber,
        shortfalls: plan.shortfalls.map((shortfall) => ({
          sku: shortfall.sku,
          requested: shortfall.requested,
          availableToReserve: shortfall.availableToReserve,
          shortfall: shortfall.shortfall,
        })),
      },
    });

    return fail(
      'INSUFFICIENT_STOCK',
      'There is not enough free stock to reserve everything on this quotation.',
      { shortfalls: plan.shortfalls },
      true,
    );
  }

  // --- the commercial copy ------------------------------------------------
  const orderNumber = await allocateDocumentNumber(tx, context.organizationId, 'ORDER');
  const { paymentStatus, fulfillmentStatus } = initialStatuses(
    quotation.paymentType as 'CASH' | 'CREDIT',
  );

  const order = await tx.salesOrder.create({
    data: {
      organizationId: context.organizationId,
      orderNumber,
      quotationId: quotation.id,
      customerId: quotation.customerId,
      status: 'OPEN',
      paymentStatus,
      fulfillmentStatus,
      currency: quotation.currency,
      paymentType: quotation.paymentType,
      paymentTermsDays: quotation.paymentTermsDays,
      paymentDueDate:
        quotation.paymentType === 'CREDIT'
          ? addDays(new Date(), quotation.paymentTermsDays)
          : null,
      // Copied, not recomputed. The quotation was approved and accepted at these figures.
      subtotalMinor: quotation.subtotalMinor,
      discountTotalMinor: quotation.discountTotalMinor,
      deliveryFeeMinor: quotation.deliveryFeeMinor,
      deliveryTaxMinor: quotation.deliveryTaxMinor,
      taxTotalMinor: quotation.taxTotalMinor,
      grandTotalMinor: quotation.grandTotalMinor,
      deliveryRequired: parsed.data.deliveryRequired,
      // The address as it stands now. Editing the customer later must not silently redirect
      // goods already promised somewhere.
      deliveryAddressSnapshot: parsed.data.deliveryRequired
        ? (quotation.customer.address ?? null)
        : null,
      createdById: context.userId,
    },
  });

  for (const item of quotation.items) {
    const orderItem = await tx.salesOrderItem.create({
      data: {
        organizationId: context.organizationId,
        salesOrderId: order.id,
        productId: item.productId,
        skuSnapshot: item.skuSnapshot,
        descriptionSnapshot: item.descriptionSnapshot,
        unitSnapshot: item.unitSnapshot,
        quantity: item.quantity,
        listUnitPriceMinor: item.listUnitPriceMinor,
        quotedUnitPriceMinor: item.quotedUnitPriceMinor,
        discountBp: item.discountBp,
        taxRateBp: item.taxRateBp,
        lineSubtotalMinor: item.lineSubtotalMinor,
        lineDiscountMinor: item.lineDiscountMinor,
        taxableAmountMinor: item.taxableAmountMinor,
        taxMinor: item.taxMinor,
        lineTotalMinor: item.lineTotalMinor,
        reservedQuantity: item.quantity,
        sortOrder: item.sortOrder,
      },
    });

    await tx.stockReservation.create({
      data: {
        organizationId: context.organizationId,
        salesOrderId: order.id,
        salesOrderItemId: orderItem.id,
        productId: item.productId!,
        quantity: item.quantity,
        status: 'ACTIVE',
      },
    });
  }

  // --- raise the aggregate, once per product ------------------------------
  for (const [productId, quantity] of plan.byProduct) {
    await tx.$executeRaw`
      UPDATE products
         SET reserved_stock = reserved_stock + ${quantity},
             updated_at = now()
       WHERE id = ${productId}::uuid
         AND organization_id = ${context.organizationId}::uuid
    `;
  }

  await recordAudit(tx, context, {
    action: 'order.created',
    entityType: 'sales_order',
    entityId: order.id,
    newState: {
      orderNumber,
      quotationId: quotation.id,
      quotationNumber: quotation.quotationNumber,
      grandTotalMinor: order.grandTotalMinor.toString(),
      paymentStatus,
      fulfillmentStatus,
      lineCount: quotation.items.length,
    },
  });

  await recordAudit(tx, context, {
    action: 'order.stock_reserved',
    entityType: 'sales_order',
    entityId: order.id,
    newState: {
      reservations: [...plan.byProduct].map(([productId, quantity]) => ({ productId, quantity })),
    },
  });

  return ok({ id: order.id, orderNumber, alreadyExisted: false });
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Cancels an open order and releases exactly what it reserved.
 *
 * "Exactly what it reserved" is why the reservation rows exist. Decrementing a shared counter by
 * a number recomputed from the order lines would drift the moment anything else touched it;
 * releasing the specific ACTIVE rows this order owns cannot.
 *
 * The quotation is deliberately left alone. It remains the record of what the customer accepted,
 * and rewriting it to tidy up a cancelled order would destroy the only evidence of the agreement.
 */
export async function cancelOrder(
  tx: TenantTransaction,
  context: ActorContext,
  orderId: string,
  reason: string,
): Promise<Result<{ released: number; alreadyCancelled: boolean }>> {
  if (!isUuid(orderId)) return fail('NOT_FOUND', 'error.notFound');

  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sales_orders
     WHERE id = ${orderId}::uuid
       AND organization_id = ${context.organizationId}::uuid
     FOR UPDATE
  `;
  if (locked.length === 0) return fail('NOT_FOUND', 'error.notFound');

  const order = await tx.salesOrder.findFirst({ where: { id: orderId } });
  if (!order) return fail('NOT_FOUND', 'error.notFound');

  // Idempotent. A second cancellation must not release a second time — the reservations are
  // already RELEASED, so re-running the release would subtract stock that was never held.
  if (order.status === 'CANCELLED') {
    return ok({ released: 0, alreadyCancelled: true });
  }

  if (order.status === 'COMPLETED') {
    return fail('INVALID_STATE_TRANSITION', 'A completed order cannot be cancelled.');
  }

  /*
   * An order with money confirmed against it cannot be cancelled.
   *
   * Added in Phase 5, when confirmed payments became real. Without it, a cancellation racing a
   * confirmation could commit second and leave a CANCELLED order carrying a CONFIRMED payment:
   * the stock released, the money recorded as received, and nothing in the system saying what
   * is owed back. There is no refund concept yet, so the only coherent answer is to refuse.
   *
   * The check is safe under concurrency because it runs *after* the order row lock above, and
   * `confirmPayment` takes that same lock before it decides. Whichever commits first, the other
   * sees it: a confirmation arriving after a cancellation is refused by the `ORDER_NOT_OPEN`
   * blocking factor, and a cancellation arriving after a confirmation is refused here.
   *
   * Counted directly rather than through the payments module, so orders keeps no dependency on
   * it — the two would otherwise reference each other.
   */
  const confirmedPayments = await tx.payment.count({
    where: { salesOrderId: orderId, status: 'CONFIRMED' },
  });
  if (confirmedPayments > 0) {
    return fail(
      'CONFLICT',
      `Payment has already been confirmed against ${order.orderNumber}, so it cannot be cancelled. Record a refund against it instead.`,
      { confirmedPayments },
      true,
    );
  }

  /*
   * Fulfilment progress blocks cancellation too, from Phase 6.
   *
   * Counted directly rather than through the fulfilment module, so orders keeps no dependency
   * on it — fulfilment already depends on orders, and the pair would otherwise reference each
   * other. The rule itself lives in `assessCancellation` and is unit-tested there; this is the
   * same rule expressed as the one query it needs.
   *
   * PENDING does not block: nothing physical has happened, and the reservations are released
   * with the order as they always were. IN_PROGRESS and PREPARED block because someone is
   * walking the yard against this order. COMPLETED blocks permanently, because the goods have
   * gone and no row change brings them back.
   */
  const blockingTask = await tx.warehouseTask.findFirst({
    where: {
      salesOrderId: orderId,
      status: { in: ['IN_PROGRESS', 'PREPARED', 'COMPLETED'] },
    },
    select: { taskNumber: true, status: true },
  });
  if (blockingTask) {
    return fail(
      'CONFLICT',
      blockingTask.status === 'COMPLETED'
        ? `The goods for ${order.orderNumber} have already left the warehouse, so it cannot be cancelled. Record a return against the stock instead.`
        : `The warehouse has started preparing ${order.orderNumber} on ${blockingTask.taskNumber}. Cancel that task first, then cancel the order.`,
      { warehouseTask: blockingTask.taskNumber, warehouseTaskStatus: blockingTask.status },
      true,
    );
  }

  const active = await tx.stockReservation.findMany({
    where: { salesOrderId: orderId, status: 'ACTIVE' },
  });

  // Same deterministic lock order as creation, so a cancellation racing a creation over the
  // same products cannot deadlock with it.
  for (const productId of lockOrder(active.map((reservation) => reservation.productId))) {
    await tx.$executeRaw`
      SELECT id FROM products
       WHERE id = ${productId}::uuid
         AND organization_id = ${context.organizationId}::uuid
       FOR UPDATE
    `;
  }

  const releasedAt = new Date();
  const byProduct = new Map<string, number>();

  for (const reservation of active) {
    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: { status: 'RELEASED', releasedAt },
    });
    byProduct.set(
      reservation.productId,
      (byProduct.get(reservation.productId) ?? 0) + reservation.quantity,
    );
  }

  for (const [productId, quantity] of byProduct) {
    await tx.$executeRaw`
      UPDATE products
         SET reserved_stock = reserved_stock - ${quantity},
             updated_at = now()
       WHERE id = ${productId}::uuid
         AND organization_id = ${context.organizationId}::uuid
    `;
  }

  await tx.salesOrderItem.updateMany({
    where: { salesOrderId: orderId },
    data: { reservedQuantity: 0 },
  });

  await tx.salesOrder.update({
    where: { id: orderId },
    data: {
      status: 'CANCELLED',
      fulfillmentStatus: 'CANCELLED',
      cancelledAt: releasedAt,
      cancelledById: context.userId,
      cancellationReason: reason.trim() || null,
    },
  });

  await recordAudit(tx, context, {
    action: 'order.cancelled',
    entityType: 'sales_order',
    entityId: orderId,
    oldState: { status: order.status, fulfillmentStatus: order.fulfillmentStatus },
    newState: { status: 'CANCELLED', reason: reason.trim() || null },
  });

  await recordAudit(tx, context, {
    action: 'order.stock_released',
    entityType: 'sales_order',
    entityId: orderId,
    newState: {
      released: [...byProduct].map(([productId, quantity]) => ({ productId, quantity })),
    },
  });

  return ok({ released: active.length, alreadyCancelled: false });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface OrderLineView {
  readonly id: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly quantity: number;
  readonly reservedQuantity: number;
  readonly listUnitPriceMinor: bigint;
  readonly discountBp: number;
  readonly taxMinor: bigint;
  readonly lineTotalMinor: bigint;
}

export interface OrderView {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: SalesOrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly fulfillmentStatus: OrderFulfillmentStatus;
  readonly currency: string;
  readonly paymentType: 'CASH' | 'CREDIT';
  readonly paymentTermsDays: number;
  readonly paymentDueDate: Date | null;
  readonly customer: { id: string; companyName: string; phone: string | null };
  readonly quotation: { id: string; quotationNumber: string };
  readonly lines: readonly OrderLineView[];
  readonly subtotalMinor: bigint;
  readonly discountTotalMinor: bigint;
  readonly deliveryFeeMinor: bigint;
  readonly deliveryTaxMinor: bigint;
  readonly taxTotalMinor: bigint;
  readonly grandTotalMinor: bigint;
  readonly deliveryRequired: boolean;
  readonly deliveryAddressSnapshot: string | null;
  readonly cancellationReason: string | null;
  /// Phase 6. Operational completion, which says nothing about money.
  readonly completedAt: Date | null;
  readonly pickedUpAt: Date | null;
  /**
   * Phase 7. An operational problem the order is carrying — a stock shortfall, a failed or lost
   * delivery, goods that came back. Deliberately not a status value: an order with a shortfall
   * is still open, and one whose goods were lost is neither finished nor cancelled.
   */
  readonly operationalException:
    | 'STOCK_SHORTFALL'
    | 'DELIVERY_FAILED'
    | 'DELIVERY_LOST'
    | 'GOODS_RETURNED'
    | null;
  readonly operationalExceptionNote: string | null;
  readonly createdAt: Date;
  readonly reservations: readonly {
    id: string;
    sku: string;
    quantity: number;
    status: string;
    releasedAt: Date | null;
  }[];
}

export async function getOrder(
  tx: TenantTransaction,
  orderId: string,
): Promise<Result<OrderView>> {
  if (!isUuid(orderId)) return fail('NOT_FOUND', 'error.notFound');

  const order = await tx.salesOrder.findFirst({
    where: { id: orderId },
    include: {
      customer: true,
      quotation: { select: { id: true, quotationNumber: true } },
      items: { orderBy: { sortOrder: 'asc' } },
      reservations: { include: { salesOrderItem: { select: { skuSnapshot: true } } } },
    },
  });
  if (!order) return fail('NOT_FOUND', 'error.notFound');

  return ok({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status as SalesOrderStatus,
    paymentStatus: order.paymentStatus as OrderPaymentStatus,
    fulfillmentStatus: order.fulfillmentStatus as OrderFulfillmentStatus,
    currency: order.currency,
    paymentType: order.paymentType as 'CASH' | 'CREDIT',
    paymentTermsDays: order.paymentTermsDays,
    paymentDueDate: order.paymentDueDate,
    customer: {
      id: order.customer.id,
      companyName: order.customer.companyName,
      phone: order.customer.phone,
    },
    quotation: order.quotation,
    lines: order.items.map((item) => ({
      id: item.id,
      sku: item.skuSnapshot,
      description: item.descriptionSnapshot,
      unit: item.unitSnapshot,
      quantity: item.quantity,
      reservedQuantity: item.reservedQuantity,
      listUnitPriceMinor: item.listUnitPriceMinor,
      discountBp: item.discountBp,
      taxMinor: item.taxMinor,
      lineTotalMinor: item.lineTotalMinor,
    })),
    subtotalMinor: order.subtotalMinor,
    discountTotalMinor: order.discountTotalMinor,
    deliveryFeeMinor: order.deliveryFeeMinor,
    deliveryTaxMinor: order.deliveryTaxMinor,
    taxTotalMinor: order.taxTotalMinor,
    grandTotalMinor: order.grandTotalMinor,
    deliveryRequired: order.deliveryRequired,
    deliveryAddressSnapshot: order.deliveryAddressSnapshot,
    cancellationReason: order.cancellationReason,
    completedAt: order.completedAt,
    pickedUpAt: order.pickedUpAt,
    operationalException: order.operationalException as OrderView['operationalException'],
    operationalExceptionNote: order.operationalExceptionNote,
    createdAt: order.createdAt,
    reservations: order.reservations.map((reservation) => ({
      id: reservation.id,
      sku: reservation.salesOrderItem.skuSnapshot,
      quantity: reservation.quantity,
      status: reservation.status,
      releasedAt: reservation.releasedAt,
    })),
  });
}

export interface OrderListRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly quotationNumber: string;
  readonly customerName: string;
  readonly status: SalesOrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly fulfillmentStatus: OrderFulfillmentStatus;
  readonly grandTotalMinor: bigint;
  readonly currency: string;
  readonly createdAt: Date;
}

export async function listOrders(
  tx: TenantTransaction,
  options: { status?: SalesOrderStatus } = {},
): Promise<OrderListRow[]> {
  const rows = await tx.salesOrder.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      customer: { select: { companyName: true } },
      quotation: { select: { quotationNumber: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    quotationNumber: row.quotation.quotationNumber,
    customerName: row.customer.companyName,
    status: row.status as SalesOrderStatus,
    paymentStatus: row.paymentStatus as OrderPaymentStatus,
    fulfillmentStatus: row.fulfillmentStatus as OrderFulfillmentStatus,
    grandTotalMinor: row.grandTotalMinor,
    currency: row.currency,
    createdAt: row.createdAt,
  }));
}

/** The shortfall detail carried on an INSUFFICIENT_STOCK refusal, for the UI to render. */
export type { LineShortfall };
