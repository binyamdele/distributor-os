import 'server-only';
import { z } from 'zod';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { isUuid } from '@/platform/ids';
import { type Result, fail, ok } from '@/platform/result';
import { recordAudit } from '@/modules/audit';
import { allocateDocumentNumber } from '@/modules/numbering';
import { recordMovement } from './movements';
import {
  type DiscrepancyStatus,
  type DiscrepancyType,
  affectedByShortfall,
  assessReconciliation,
  canTransitionDiscrepancy,
  classifyVariance,
  shortfallLeavesOrderUnfulfillable,
} from './discrepancy';
import {
  type FailureResolution,
  type ReturnStatus,
  assessInspection,
  assessRetryEligibility,
  canTransitionReturn,
  restockEffect,
} from './returns-model';

export * from './movements';
export * from './discrepancy';
export * from './returns-model';
export * from './queries';

/**
 * Fulfilment exceptions: inventory discrepancies, returns, and failed-delivery resolution.
 *
 * ## Lock ordering
 *
 * Phase 6 established one total order and Phase 7 extends it by *insertion*, never by prepending:
 *
 *     payment → sales_order → warehouse_task → delivery → return
 *              → inventory_discrepancy → products (ascending id) → reservations
 *
 * Every operation takes the subsequence it needs, always left to right. A standalone discrepancy
 * — one raised during a stock count, belonging to no order — takes a suffix of the same chain
 * (`discrepancy → products`), which is consistent rather than a second convention.
 *
 * The one addition to an existing path: `completeWarehouseTask` now locks its task's open
 * discrepancies before it locks products. That keeps it in order, and it is what makes a
 * handover racing a reconciliation serialise instead of interleaving.
 */

async function lockOrderRow(
  tx: TenantTransaction,
  organizationId: string,
  salesOrderId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sales_orders
     WHERE id = ${salesOrderId}::uuid AND organization_id = ${organizationId}::uuid
     FOR UPDATE
  `;
  return rows.length > 0;
}

async function lockProducts(
  tx: TenantTransaction,
  organizationId: string,
  productIds: readonly string[],
): Promise<void> {
  // Ascending id, one statement each — the Phase 4 rule, unchanged.
  for (const productId of [...new Set(productIds)].sort()) {
    await tx.$executeRaw`
      SELECT id FROM products
       WHERE id = ${productId}::uuid AND organization_id = ${organizationId}::uuid
       FOR UPDATE
    `;
  }
}

// ---------------------------------------------------------------------------
// Reporting a discrepancy
// ---------------------------------------------------------------------------

export const reportDiscrepancySchema = z.object({
  productId: z.string().uuid(),
  physicalCount: z.coerce.number().int().min(0),
  warehouseTaskId: z.string().uuid().optional().or(z.literal('')),
  note: z.string().trim().max(1000).optional().or(z.literal('')),
});

export interface ReportedDiscrepancy {
  readonly id: string;
  readonly discrepancyNumber: string;
  readonly variance: number;
  readonly type: DiscrepancyType;
}

/**
 * Records that somebody counted the shelf and disagrees with the system.
 *
 * **Changes no stock.** That is the entire point of separating this from resolution: a physical
 * count is an observation, and an observation that silently rewrote inventory would let one
 * person move stock by typing a number into a box. It would also destroy the only thing that
 * makes the disagreement investigable — what the system claimed before anybody argued with it.
 *
 * Every observed figure is snapshotted here rather than re-read later, for the same reason.
 */
export async function reportDiscrepancy(
  tx: TenantTransaction,
  context: ActorContext,
  raw: unknown,
): Promise<Result<ReportedDiscrepancy>> {
  const parsed = reportDiscrepancySchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'error.generic', {
      field: parsed.error.issues[0]?.path.join('.'),
    });
  }
  const { productId, physicalCount } = parsed.data;
  const taskId = parsed.data.warehouseTaskId || null;

  const product = await tx.product.findFirst({ where: { id: productId } });
  if (!product) return fail('NOT_FOUND', 'error.notFound');

  let salesOrderId: string | null = null;
  let expectedTaskQuantity: number | null = null;

  if (taskId) {
    if (!isUuid(taskId)) return fail('NOT_FOUND', 'error.notFound');
    const task = await tx.warehouseTask.findFirst({
      where: { id: taskId },
      include: { items: { where: { productId } } },
    });
    if (!task) return fail('NOT_FOUND', 'error.notFound');
    salesOrderId = task.salesOrderId;
    expectedTaskQuantity = task.items.reduce((sum, item) => sum + item.quantityRequired, 0) || null;
  }

  const { variance, type } = classifyVariance(product.availableStock, physicalCount);

  const discrepancyNumber = await allocateDocumentNumber(
    tx,
    context.organizationId,
    'DISCREPANCY',
  );

  const created = await tx.inventoryDiscrepancy.create({
    data: {
      organizationId: context.organizationId,
      discrepancyNumber,
      warehouseTaskId: taskId,
      salesOrderId,
      productId,
      discrepancyType: type,
      status: 'OPEN',
      systemOnHandQuantity: product.availableStock,
      systemReservedQuantity: product.reservedStock,
      expectedTaskQuantity,
      physicalCountQuantity: physicalCount,
      varianceQuantity: variance,
      reportNote: parsed.data.note?.trim() || null,
      reportedById: context.userId,
    },
  });

  await recordAudit(tx, context, {
    action: 'inventory_discrepancy.reported',
    entityType: 'inventory_discrepancy',
    entityId: created.id,
    newState: {
      discrepancyNumber,
      sku: product.sku,
      systemOnHand: product.availableStock,
      systemReserved: product.reservedStock,
      physicalCount,
      variance,
      warehouseTaskId: taskId,
      // Said plainly in the log, because it is the property most easily assumed away.
      stockChanged: false,
    },
  });

  return ok({ id: created.id, discrepancyNumber, variance, type });
}

// ---------------------------------------------------------------------------
// Review and reconciliation
// ---------------------------------------------------------------------------

async function loadDiscrepancyForMutation(
  tx: TenantTransaction,
  context: ActorContext,
  discrepancyId: string,
) {
  if (!isUuid(discrepancyId)) return null;

  const found = await tx.inventoryDiscrepancy.findFirst({
    where: { id: discrepancyId },
    select: { salesOrderId: true, productId: true },
  });
  if (!found) return null;

  // order (if any) → discrepancy → product. A standalone discrepancy takes the suffix.
  if (found.salesOrderId) {
    if (!(await lockOrderRow(tx, context.organizationId, found.salesOrderId))) return null;
  }

  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM inventory_discrepancies
     WHERE id = ${discrepancyId}::uuid AND organization_id = ${context.organizationId}::uuid
     FOR UPDATE
  `;
  if (locked.length === 0) return null;

  await lockProducts(tx, context.organizationId, [found.productId]);

  return tx.inventoryDiscrepancy.findFirst({
    where: { id: discrepancyId },
    include: { product: true, warehouseTask: true, salesOrder: true },
  });
}

/** Picks a discrepancy up for investigation. Looking is not deciding, and moves no stock. */
export async function reviewDiscrepancy(
  tx: TenantTransaction,
  context: ActorContext,
  discrepancyId: string,
): Promise<Result<{ alreadyUnderReview: boolean }>> {
  const discrepancy = await loadDiscrepancyForMutation(tx, context, discrepancyId);
  if (!discrepancy) return fail('NOT_FOUND', 'error.notFound');

  if (discrepancy.status === 'UNDER_REVIEW') return ok({ alreadyUnderReview: true });

  if (!canTransitionDiscrepancy(discrepancy.status as DiscrepancyStatus, 'UNDER_REVIEW')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This discrepancy is ${discrepancy.status.toLowerCase().replace(/_/g, ' ')}.`,
    );
  }

  await tx.inventoryDiscrepancy.update({
    where: { id: discrepancyId },
    data: { status: 'UNDER_REVIEW', reviewedById: context.userId, reviewedAt: new Date() },
  });

  await recordAudit(tx, context, {
    action: 'inventory_discrepancy.under_review',
    entityType: 'inventory_discrepancy',
    entityId: discrepancyId,
    oldState: { status: discrepancy.status },
    newState: { status: 'UNDER_REVIEW', discrepancyNumber: discrepancy.discrepancyNumber },
  });

  return ok({ alreadyUnderReview: false });
}

export interface ReconciliationResult {
  readonly applied: boolean;
  readonly delta: number;
  readonly stockAfter: number;
}

/**
 * Writes a verified physical count into stock.
 *
 * The transaction:
 *
 *   1. lock the order (if the discrepancy has one), then the discrepancy, then the product
 *   2. re-read the live on-hand and the live ACTIVE reservation total *inside* the locks
 *   3. refuse if stock has moved since the count was taken — the delta would be from a stale
 *      baseline, and the right answer is to count again
 *   4. refuse if the verified count cannot cover what is already committed
 *   5. apply the delta, record a movement, resolve the discrepancy
 *
 * Step 2 is why it is safe to run this concurrently with a warehouse handover: both re-derive
 * inside the product lock, and whichever arrives second sees what the first did.
 */
export async function reconcileDiscrepancy(
  tx: TenantTransaction,
  context: ActorContext,
  discrepancyId: string,
  note: string | null,
): Promise<Result<ReconciliationResult>> {
  const discrepancy = await loadDiscrepancyForMutation(tx, context, discrepancyId);
  if (!discrepancy) return fail('NOT_FOUND', 'error.notFound');

  const activeReserved = await tx.stockReservation.aggregate({
    where: { productId: discrepancy.productId, status: 'ACTIVE' },
    _sum: { quantity: true },
  });
  const currentReserved = activeReserved._sum.quantity ?? 0;

  const verdict = assessReconciliation({
    status: discrepancy.status as DiscrepancyStatus,
    currentOnHand: discrepancy.product.availableStock,
    currentReserved,
    physicalCount: discrepancy.physicalCountQuantity,
    reportedSystemOnHand: discrepancy.systemOnHandQuantity,
  });

  if (verdict.refusal === 'NOTHING_TO_CHANGE') {
    // Still a resolution: the count happened and the record should say the system was right.
    return resolveWithoutChange(tx, context, discrepancyId, discrepancy.discrepancyNumber, note);
  }

  if (!verdict.canApply) {
    if (verdict.refusal === 'RESERVATION_SHORTFALL') {
      // Recorded on the row so the exceptions list can show it and the manager can act, rather
      // than being a message that disappears when the page is closed.
      await tx.inventoryDiscrepancy.update({
        where: { id: discrepancyId },
        data: {
          status: 'UNDER_REVIEW',
          reviewedById: discrepancy.reviewedById ?? context.userId,
          reviewedAt: discrepancy.reviewedAt ?? new Date(),
          reservationShortfall: verdict.reservationShortfall,
        },
      });

      await recordAudit(tx, context, {
        action: 'inventory_discrepancy.reservation_shortfall_detected',
        entityType: 'inventory_discrepancy',
        entityId: discrepancyId,
        newState: {
          discrepancyNumber: discrepancy.discrepancyNumber,
          sku: discrepancy.product.sku,
          verifiedCount: discrepancy.physicalCountQuantity,
          committed: currentReserved,
          shortfall: verdict.reservationShortfall,
          stockChanged: false,
        },
      });
    }

    return fail('CONFLICT', verdict.detail, { refusal: verdict.refusal }, true);
  }

  const stockAfter = discrepancy.product.availableStock + verdict.delta;

  await tx.$executeRaw`
    UPDATE products
       SET available_stock = available_stock + ${verdict.delta},
           updated_at = now()
     WHERE id = ${discrepancy.productId}::uuid
       AND organization_id = ${context.organizationId}::uuid
  `;

  await recordMovement(tx, context, {
    productId: discrepancy.productId,
    movementType: 'DISCREPANCY_RECONCILIATION',
    delta: verdict.delta,
    stockAfter,
    reason: `${discrepancy.discrepancyNumber}: verified physical count ${discrepancy.physicalCountQuantity}`,
    relatedOrderId: discrepancy.salesOrderId,
    relatedDiscrepancyId: discrepancyId,
  });

  await tx.inventoryDiscrepancy.update({
    where: { id: discrepancyId },
    data: {
      status: 'RESOLVED',
      resolutionType: 'STOCK_RECONCILED',
      resolutionNote: note?.trim() || null,
      resolvedById: context.userId,
      resolvedAt: new Date(),
      reservationShortfall: null,
    },
  });

  await recordAudit(tx, context, {
    action: 'inventory_discrepancy.reconciled',
    entityType: 'inventory_discrepancy',
    entityId: discrepancyId,
    oldState: { status: discrepancy.status, availableStock: discrepancy.product.availableStock },
    newState: {
      status: 'RESOLVED',
      discrepancyNumber: discrepancy.discrepancyNumber,
      sku: discrepancy.product.sku,
      delta: verdict.delta,
      availableStock: stockAfter,
      verifiedCount: discrepancy.physicalCountQuantity,
    },
  });

  return ok({ applied: true, delta: verdict.delta, stockAfter });
}

async function resolveWithoutChange(
  tx: TenantTransaction,
  context: ActorContext,
  discrepancyId: string,
  discrepancyNumber: string,
  note: string | null,
): Promise<Result<ReconciliationResult>> {
  const product = await tx.inventoryDiscrepancy.findFirstOrThrow({
    where: { id: discrepancyId },
    include: { product: true },
  });

  await tx.inventoryDiscrepancy.update({
    where: { id: discrepancyId },
    data: {
      status: 'RESOLVED',
      resolutionType: 'COUNT_CONFIRMED_NO_CHANGE',
      resolutionNote: note?.trim() || null,
      resolvedById: context.userId,
      resolvedAt: new Date(),
      reservationShortfall: null,
    },
  });

  await recordAudit(tx, context, {
    action: 'inventory_discrepancy.count_confirmed',
    entityType: 'inventory_discrepancy',
    entityId: discrepancyId,
    newState: { discrepancyNumber, sku: product.product.sku, stockChanged: false },
  });

  return ok({ applied: false, delta: 0, stockAfter: product.product.availableStock });
}

/** Withdraws a discrepancy — miscounted, wrong product, wrong bay. Moves no stock. */
export async function cancelDiscrepancy(
  tx: TenantTransaction,
  context: ActorContext,
  discrepancyId: string,
  reason: string,
): Promise<Result<{ alreadyCancelled: boolean }>> {
  const discrepancy = await loadDiscrepancyForMutation(tx, context, discrepancyId);
  if (!discrepancy) return fail('NOT_FOUND', 'error.notFound');

  if (discrepancy.status === 'CANCELLED') return ok({ alreadyCancelled: true });
  if (!canTransitionDiscrepancy(discrepancy.status as DiscrepancyStatus, 'CANCELLED')) {
    return fail('INVALID_STATE_TRANSITION', 'A resolved discrepancy cannot be withdrawn.');
  }
  if (!reason.trim()) return fail('VALIDATION_FAILED', 'Say why it is being withdrawn.');

  await tx.inventoryDiscrepancy.update({
    where: { id: discrepancyId },
    data: { status: 'CANCELLED', resolutionNote: reason.trim() },
  });

  await recordAudit(tx, context, {
    action: 'inventory_discrepancy.cancelled',
    entityType: 'inventory_discrepancy',
    entityId: discrepancyId,
    oldState: { status: discrepancy.status },
    newState: { status: 'CANCELLED', reason: reason.trim(), stockChanged: false },
  });

  return ok({ alreadyCancelled: false });
}

// ---------------------------------------------------------------------------
// Reservation shortfall
// ---------------------------------------------------------------------------

export interface ShortfallResolution {
  readonly reservationId: string;
  readonly newQuantity: number;
}

/**
 * Reduces or releases one named order's reservation, so the yard can cover what it still holds.
 *
 * Sales makes this call, never the warehouse and never a rule. There is no ranking by order age,
 * order value or customer, and no model is consulted: somebody is not getting their cement
 * today, and choosing who is a conversation with a relationship behind it.
 *
 * **The accepted order is not rewritten.** Its quantities are what the customer agreed to buy,
 * and editing them to make the shortage disappear would falsify the agreement. The order is left
 * saying "80 required, 60 reserved" and carries a visible `STOCK_SHORTFALL` exception, which is
 * the honest description of where it stands.
 */
export async function resolveReservationShortfall(
  tx: TenantTransaction,
  context: ActorContext,
  reservationId: string,
  newQuantity: number,
  reason: string,
): Promise<Result<{ released: boolean; previousQuantity: number; orderUnfulfillable: boolean }>> {
  if (!isUuid(reservationId)) return fail('NOT_FOUND', 'error.notFound');
  if (newQuantity < 0) return fail('VALIDATION_FAILED', 'A reservation cannot be negative.');
  if (!reason.trim()) return fail('VALIDATION_FAILED', 'Say why this order is giving way.');

  const found = await tx.stockReservation.findFirst({
    where: { id: reservationId },
    select: { salesOrderId: true, productId: true },
  });
  if (!found) return fail('NOT_FOUND', 'error.notFound');

  // order → product → reservation, the module-wide ordering.
  if (!(await lockOrderRow(tx, context.organizationId, found.salesOrderId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  await lockProducts(tx, context.organizationId, [found.productId]);

  const reservation = await tx.stockReservation.findFirst({
    where: { id: reservationId },
    include: { salesOrder: true, salesOrderItem: true, product: true },
  });
  if (!reservation) return fail('NOT_FOUND', 'error.notFound');

  if (reservation.status !== 'ACTIVE') {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This reservation is ${reservation.status.toLowerCase()} and holds no stock.`,
    );
  }
  if (newQuantity >= reservation.quantity) {
    return fail(
      'VALIDATION_FAILED',
      `This reservation holds ${reservation.quantity}. Reducing it means a smaller number.`,
    );
  }

  const previousQuantity = reservation.quantity;
  const givenUp = previousQuantity - newQuantity;
  const releasing = newQuantity === 0;

  if (releasing) {
    await tx.stockReservation.update({
      where: { id: reservationId },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
  } else {
    await tx.stockReservation.update({
      where: { id: reservationId },
      data: { quantity: newQuantity },
    });
  }

  // The maintained aggregate follows the rows, in the same transaction, as it always has.
  await tx.$executeRaw`
    UPDATE products
       SET reserved_stock = reserved_stock - ${givenUp},
           updated_at = now()
     WHERE id = ${reservation.productId}::uuid
       AND organization_id = ${context.organizationId}::uuid
  `;

  await tx.salesOrderItem.update({
    where: { id: reservation.salesOrderItemId },
    data: { reservedQuantity: newQuantity },
  });

  const { unfulfillable, shortfall } = shortfallLeavesOrderUnfulfillable(
    reservation.salesOrderItem.quantity,
    newQuantity,
  );

  if (unfulfillable) {
    await tx.salesOrder.update({
      where: { id: reservation.salesOrderId },
      data: {
        operationalException: 'STOCK_SHORTFALL',
        operationalExceptionNote: `${reservation.product.sku}: ${reservation.salesOrderItem.quantity} required, ${newQuantity} reserved.`,
      },
    });
  }

  await recordAudit(tx, context, {
    action: 'reservation.reduced_for_shortfall',
    entityType: 'sales_order',
    entityId: reservation.salesOrderId,
    oldState: { reservedQuantity: previousQuantity },
    newState: {
      reservationId,
      orderNumber: reservation.salesOrder.orderNumber,
      sku: reservation.product.sku,
      reservedQuantity: newQuantity,
      givenUp,
      released: releasing,
      reason: reason.trim(),
      orderRequires: reservation.salesOrderItem.quantity,
      shortfall,
      // The commercial record is untouched. Stated so the log makes that unambiguous.
      acceptedQuantityChanged: false,
    },
  });

  return ok({ released: releasing, previousQuantity, orderUnfulfillable: unfulfillable });
}

// ---------------------------------------------------------------------------
// Failed-delivery resolution: retry
// ---------------------------------------------------------------------------

async function loadDeliveryForResolution(
  tx: TenantTransaction,
  context: ActorContext,
  deliveryId: string,
) {
  if (!isUuid(deliveryId)) return null;

  const found = await tx.$queryRaw<{ sales_order_id: string }[]>`
    SELECT sales_order_id FROM deliveries
     WHERE id = ${deliveryId}::uuid AND organization_id = ${context.organizationId}::uuid
  `;
  const salesOrderId = found[0]?.sales_order_id;
  if (!salesOrderId) return null;

  if (!(await lockOrderRow(tx, context.organizationId, salesOrderId))) return null;

  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM deliveries
     WHERE id = ${deliveryId}::uuid AND organization_id = ${context.organizationId}::uuid
     FOR UPDATE
  `;
  if (locked.length === 0) return null;

  return tx.delivery.findFirst({
    where: { id: deliveryId },
    include: { salesOrder: { include: { customer: true } }, returns: true, retries: true },
  });
}

/**
 * Sends a failed delivery out again, as a new attempt.
 *
 * **Creates no reservation, consumes no stock, decrements nothing, and touches no commercial
 * figure.** Stock left the yard when the warehouse handed the goods over; the lorry is still
 * carrying them, and a second attempt to reach the customer is not a second shipment. Consuming
 * again here would remove the same units from inventory twice, which is the single most
 * expensive mistake this workflow could make — so it is asserted by tests rather than trusted.
 *
 * The original failed delivery is not modified except to record *how* it was resolved. FAILED
 * stays FAILED: the failure happened, and the retry is a second fact about it.
 */
export async function createDeliveryRetry(
  tx: TenantTransaction,
  context: ActorContext,
  deliveryId: string,
): Promise<Result<{ id: string; deliveryNumber: string; attemptNumber: number }>> {
  const delivery = await loadDeliveryForResolution(tx, context, deliveryId);
  if (!delivery) return fail('NOT_FOUND', 'error.notFound');

  const goodsRestocked = delivery.returns.some((entry) => entry.status === 'COMPLETED');
  const hasLiveRetry = delivery.retries.some((retry) => retry.status !== 'CANCELLED');

  const verdict = assessRetryEligibility({
    deliveryStatus: delivery.status,
    existingResolution: (delivery.failureResolution as FailureResolution | null) ?? null,
    goodsRestocked,
    hasLiveRetry,
    orderStatus: delivery.salesOrder.status,
  });

  if (!verdict.eligible) {
    return fail('CONFLICT', verdict.detail, { refusal: verdict.refusal }, true);
  }

  const deliveryNumber = await allocateDocumentNumber(tx, context.organizationId, 'DELIVERY');
  const attemptNumber = delivery.attemptNumber + 1;

  // Snapshots copied from the failed attempt, not re-read from the customer. The destination
  // that was attempted is the destination being attempted again.
  const retry = await tx.delivery.create({
    data: {
      organizationId: context.organizationId,
      deliveryNumber,
      salesOrderId: delivery.salesOrderId,
      warehouseTaskId: delivery.warehouseTaskId,
      status: 'PENDING',
      customerNameSnapshot: delivery.customerNameSnapshot,
      customerPhoneSnapshot: delivery.customerPhoneSnapshot,
      destinationTextSnapshot: delivery.destinationTextSnapshot,
      assignedDriverName: delivery.assignedDriverName,
      assignedDriverPhone: delivery.assignedDriverPhone,
      vehicleReference: delivery.vehicleReference,
      retryOfDeliveryId: delivery.id,
      attemptNumber,
    },
  });

  await tx.delivery.update({
    where: { id: deliveryId },
    data: {
      failureResolution: 'RETRY_DELIVERY',
      resolvedById: context.userId,
      resolvedAt: new Date(),
    },
  });

  // The order is no longer stuck on an unresolved failure; a live attempt exists again.
  if (delivery.salesOrder.operationalException === 'DELIVERY_FAILED') {
    await tx.salesOrder.update({
      where: { id: delivery.salesOrderId },
      data: { operationalException: null, operationalExceptionNote: null },
    });
  }

  await recordAudit(tx, context, {
    action: 'delivery.retry_created',
    entityType: 'delivery',
    entityId: retry.id,
    newState: {
      deliveryNumber,
      attemptNumber,
      retryOf: delivery.deliveryNumber,
      orderNumber: delivery.salesOrder.orderNumber,
      // The property the whole operation turns on, recorded so it is checkable from the log.
      stockConsumed: false,
      reservationCreated: false,
    },
  });

  return ok({ id: retry.id, deliveryNumber, attemptNumber });
}

/**
 * Records that goods left and are not coming back.
 *
 * No stock is restored, because there is nothing to restore — the units are gone. No payment is
 * touched, because money that arrived is money that arrived. What this creates is a visible
 * obligation: an order the customer paid for and did not receive, which somebody has to settle
 * commercially. Settling it is a later phase, and pretending otherwise here would be worse than
 * leaving it open.
 */
export async function resolveDeliveryLoss(
  tx: TenantTransaction,
  context: ActorContext,
  deliveryId: string,
  note: string,
): Promise<Result<{ alreadyResolved: boolean }>> {
  const delivery = await loadDeliveryForResolution(tx, context, deliveryId);
  if (!delivery) return fail('NOT_FOUND', 'error.notFound');

  if (delivery.status !== 'FAILED') {
    return fail('INVALID_STATE_TRANSITION', 'Only a failed delivery can be written off.');
  }
  if (delivery.failureResolution === 'LOST_OR_UNRECOVERABLE') {
    return ok({ alreadyResolved: true });
  }
  if (delivery.failureResolution) {
    return fail(
      'CONFLICT',
      `This failure was already resolved as ${delivery.failureResolution.toLowerCase().replace(/_/g, ' ')}.`,
      undefined,
      true,
    );
  }
  if (!note.trim()) return fail('VALIDATION_FAILED', 'Say what happened to the goods.');

  await tx.delivery.update({
    where: { id: deliveryId },
    data: {
      failureResolution: 'LOST_OR_UNRECOVERABLE',
      resolvedById: context.userId,
      resolvedAt: new Date(),
      failureNote: note.trim(),
    },
  });

  await tx.salesOrder.update({
    where: { id: delivery.salesOrderId },
    data: {
      operationalException: 'DELIVERY_LOST',
      operationalExceptionNote: note.trim(),
    },
  });

  await recordAudit(tx, context, {
    action: 'delivery.written_off',
    entityType: 'delivery',
    entityId: deliveryId,
    newState: {
      deliveryNumber: delivery.deliveryNumber,
      orderNumber: delivery.salesOrder.orderNumber,
      note: note.trim(),
      // Both stated, because both are what somebody will look for.
      stockRestored: false,
      paymentChanged: false,
      paymentStatus: delivery.salesOrder.paymentStatus,
    },
  });

  return ok({ alreadyResolved: false });
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/**
 * Opens a return against a failed delivery.
 *
 * The expected quantities come from the warehouse task that shipped the goods, so a return
 * cannot claim more than went out. Nothing physical has happened yet — this is the record that
 * goods are on their way back.
 */
export async function createReturn(
  tx: TenantTransaction,
  context: ActorContext,
  deliveryId: string,
  note: string | null,
): Promise<Result<{ id: string; returnNumber: string; lines: number }>> {
  const delivery = await loadDeliveryForResolution(tx, context, deliveryId);
  if (!delivery) return fail('NOT_FOUND', 'error.notFound');

  if (delivery.status !== 'FAILED') {
    return fail(
      'INVALID_STATE_TRANSITION',
      'A return is raised against a delivery that failed. This one has not.',
    );
  }

  const live = delivery.returns.find((entry) => entry.status !== 'CANCELLED');
  if (live) {
    return ok({ id: live.id, returnNumber: live.returnNumber, lines: 0 });
  }

  if (delivery.failureResolution && delivery.failureResolution !== 'RETURNED_TO_WAREHOUSE') {
    return fail(
      'CONFLICT',
      `This failure was already resolved as ${delivery.failureResolution.toLowerCase().replace(/_/g, ' ')}.`,
      undefined,
      true,
    );
  }

  const taskItems = await tx.warehouseTaskItem.findMany({
    where: { warehouseTaskId: delivery.warehouseTaskId },
    orderBy: { createdAt: 'asc' },
  });
  if (taskItems.length === 0) {
    return fail('CONFLICT', 'Nothing is recorded as having gone out on this delivery.');
  }

  const returnNumber = await allocateDocumentNumber(tx, context.organizationId, 'RETURN');

  const created = await tx.return.create({
    data: {
      organizationId: context.organizationId,
      returnNumber,
      salesOrderId: delivery.salesOrderId,
      deliveryId,
      status: 'EXPECTED',
      returnReason:
        delivery.failureReason === 'CUSTOMER_REJECTED' ? 'CUSTOMER_REJECTED' : 'DELIVERY_FAILED',
      note: note?.trim() || null,
      createdById: context.userId,
    },
  });

  for (const item of taskItems) {
    await tx.returnItem.create({
      data: {
        organizationId: context.organizationId,
        returnId: created.id,
        salesOrderItemId: item.salesOrderItemId,
        productId: item.productId,
        skuSnapshot: item.skuSnapshot,
        descriptionSnapshot: item.descriptionSnapshot,
        unitSnapshot: item.unitSnapshot,
        quantityDispatched: item.quantityRequired,
        quantityExpected: item.quantityRequired,
        /*
         * Nothing has arrived yet, so all of it is outstanding.
         *
         * Not a cosmetic default: the invariant is expected = received + missing, and seeding
         * missing to zero would make it false for every return between being raised and being
         * inspected. Saying "ten expected, none here" is also simply what is true at that
         * moment, and inspection redistributes it.
         */
        quantityMissing: item.quantityRequired,
      },
    });
  }

  await tx.delivery.update({
    where: { id: deliveryId },
    data: {
      failureResolution: 'RETURNED_TO_WAREHOUSE',
      resolvedById: context.userId,
      resolvedAt: new Date(),
    },
  });

  await tx.salesOrder.update({
    where: { id: delivery.salesOrderId },
    data: {
      operationalException: 'GOODS_RETURNED',
      operationalExceptionNote: `Goods from ${delivery.deliveryNumber} are coming back on ${returnNumber}.`,
    },
  });

  await recordAudit(tx, context, {
    action: 'return.created',
    entityType: 'return',
    entityId: created.id,
    newState: {
      returnNumber,
      deliveryNumber: delivery.deliveryNumber,
      orderNumber: delivery.salesOrder.orderNumber,
      lines: taskItems.length,
      stockChanged: false,
    },
  });

  return ok({ id: created.id, returnNumber, lines: taskItems.length });
}

async function loadReturnForMutation(
  tx: TenantTransaction,
  context: ActorContext,
  returnId: string,
) {
  if (!isUuid(returnId)) return null;

  const found = await tx.return.findFirst({
    where: { id: returnId },
    select: { salesOrderId: true, deliveryId: true },
  });
  if (!found) return null;

  // order → delivery → return, the module-wide ordering.
  if (!(await lockOrderRow(tx, context.organizationId, found.salesOrderId))) return null;
  await tx.$executeRaw`
    SELECT id FROM deliveries
     WHERE id = ${found.deliveryId}::uuid AND organization_id = ${context.organizationId}::uuid
     FOR UPDATE
  `;
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM returns
     WHERE id = ${returnId}::uuid AND organization_id = ${context.organizationId}::uuid
     FOR UPDATE
  `;
  if (locked.length === 0) return null;

  return tx.return.findFirst({
    where: { id: returnId },
    include: { items: { orderBy: { createdAt: 'asc' } }, delivery: true, salesOrder: true },
  });
}

/** Records that the goods physically arrived back in the yard. Moves no stock yet. */
export async function receiveReturn(
  tx: TenantTransaction,
  context: ActorContext,
  returnId: string,
): Promise<Result<{ alreadyReceived: boolean }>> {
  const entry = await loadReturnForMutation(tx, context, returnId);
  if (!entry) return fail('NOT_FOUND', 'error.notFound');

  if (entry.status === 'RECEIVED') return ok({ alreadyReceived: true });
  if (!canTransitionReturn(entry.status as ReturnStatus, 'RECEIVED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This return is ${entry.status.toLowerCase()} and cannot be received.`,
    );
  }

  await tx.return.update({
    where: { id: returnId },
    data: { status: 'RECEIVED', receivedById: context.userId, receivedAt: new Date() },
  });

  await recordAudit(tx, context, {
    action: 'return.received',
    entityType: 'return',
    entityId: returnId,
    oldState: { status: entry.status },
    newState: { status: 'RECEIVED', returnNumber: entry.returnNumber, stockChanged: false },
  });

  return ok({ alreadyReceived: false });
}

export const inspectionLineSchema = z.object({
  itemId: z.string().uuid(),
  received: z.coerce.number().int().min(0),
  restockable: z.coerce.number().int().min(0),
  damaged: z.coerce.number().int().min(0),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

/**
 * Records what actually came back, and in what condition. Still moves no stock.
 *
 * The split has to add up before it can be saved — every returned unit is either sellable or
 * damaged, and anything expected that did not arrive is recorded as missing rather than being
 * quietly dropped from the sum. `missing` is derived rather than typed, so the invariant cannot
 * be satisfied by adjusting the wrong number.
 */
export async function inspectReturn(
  tx: TenantTransaction,
  context: ActorContext,
  returnId: string,
  raw: unknown,
): Promise<Result<{ restockable: number; damaged: number; missing: number }>> {
  const parsed = z.array(inspectionLineSchema).min(1).safeParse(raw);
  if (!parsed.success) return fail('VALIDATION_FAILED', 'error.generic');

  const entry = await loadReturnForMutation(tx, context, returnId);
  if (!entry) return fail('NOT_FOUND', 'error.notFound');

  if (entry.status !== 'RECEIVED' && entry.status !== 'INSPECTED') {
    return fail(
      'INVALID_STATE_TRANSITION',
      'Record the goods as received before inspecting them.',
    );
  }

  const totals = { restockable: 0, damaged: 0, missing: 0 };

  for (const line of parsed.data) {
    const item = entry.items.find((candidate) => candidate.id === line.itemId);
    if (!item) return fail('NOT_FOUND', 'error.notFound');

    const verdict = assessInspection({
      quantityDispatched: item.quantityDispatched,
      quantityExpected: item.quantityExpected,
      quantityReceived: line.received,
      quantityRestockable: line.restockable,
      quantityDamaged: line.damaged,
    });

    if (!verdict.valid) {
      return fail('VALIDATION_FAILED', `${item.descriptionSnapshot}: ${verdict.detail}`, {
        itemId: item.id,
        problem: verdict.problem,
      });
    }

    await tx.returnItem.update({
      where: { id: item.id },
      data: {
        quantityReceived: line.received,
        quantityRestockable: line.restockable,
        quantityDamaged: line.damaged,
        quantityMissing: verdict.quantityMissing,
        disposition: verdict.disposition,
        note: line.note?.trim() || null,
      },
    });

    totals.restockable += line.restockable;
    totals.damaged += line.damaged;
    totals.missing += verdict.quantityMissing;
  }

  await tx.return.update({
    where: { id: returnId },
    data: { status: 'INSPECTED', inspectedById: context.userId, inspectedAt: new Date() },
  });

  await recordAudit(tx, context, {
    action: 'return.inspected',
    entityType: 'return',
    entityId: returnId,
    oldState: { status: entry.status },
    newState: {
      status: 'INSPECTED',
      returnNumber: entry.returnNumber,
      ...totals,
      stockChanged: false,
    },
  });

  return ok(totals);
}

export interface ReturnCompletionResult {
  readonly alreadyCompleted: boolean;
  readonly restocked: readonly { productId: string; sku: string; quantity: number }[];
  readonly damaged: number;
  readonly missing: number;
}

/**
 * Puts the sellable portion back on the shelf.
 *
 * The only operation in this phase that increases physical stock, and it increases it by the
 * restockable quantity and nothing else. Damaged units are physically present and commercially
 * worthless; missing units are not present at all. Both stay in the return record so that
 * "eighty went out" can always be reconciled against what came back.
 *
 * **No reservation is recreated.** The original was consumed when the goods left, and it stays
 * consumed — those units *were* shipped against that order. The returned goods come back as free
 * stock, because whether this customer still wants them is an open commercial question and not
 * one the warehouse should answer by silently re-committing inventory to them.
 */
export async function completeReturn(
  tx: TenantTransaction,
  context: ActorContext,
  returnId: string,
): Promise<Result<ReturnCompletionResult>> {
  const entry = await loadReturnForMutation(tx, context, returnId);
  if (!entry) return fail('NOT_FOUND', 'error.notFound');

  if (entry.status === 'COMPLETED') {
    return ok({ alreadyCompleted: true, restocked: [], damaged: 0, missing: 0 });
  }
  if (!canTransitionReturn(entry.status as ReturnStatus, 'COMPLETED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This return is ${entry.status.toLowerCase()}. Inspect it before completing.`,
    );
  }

  const productIds = entry.items
    .map((item) => item.productId)
    .filter((id): id is string => id !== null);
  await lockProducts(tx, context.organizationId, productIds);

  const byProduct = restockEffect(
    entry.items.map((item) => ({
      productId: item.productId ?? '',
      quantityRestockable: item.quantityRestockable,
    })),
  );
  byProduct.delete('');

  const products = await tx.product.findMany({ where: { id: { in: [...byProduct.keys()] } } });
  const productById = new Map(products.map((product) => [product.id, product]));
  const restocked: { productId: string; sku: string; quantity: number }[] = [];

  for (const productId of [...byProduct.keys()].sort()) {
    const quantity = byProduct.get(productId)!;
    const product = productById.get(productId);
    if (!product) {
      return fail(
        'CONFLICT',
        'A product on this return is no longer in the catalogue, so it cannot be restocked against it.',
        undefined,
        true,
      );
    }

    const stockAfter = product.availableStock + quantity;

    await tx.$executeRaw`
      UPDATE products
         SET available_stock = available_stock + ${quantity},
             updated_at = now()
       WHERE id = ${productId}::uuid
         AND organization_id = ${context.organizationId}::uuid
    `;

    await recordMovement(tx, context, {
      productId,
      movementType: 'RETURN_RESTOCK',
      delta: quantity,
      stockAfter,
      reason: `${entry.returnNumber}: returned from ${entry.delivery.deliveryNumber}, inspected as sellable`,
      relatedOrderId: entry.salesOrderId,
      relatedReturnId: returnId,
    });

    restocked.push({ productId, sku: product.sku, quantity });

    await recordAudit(tx, context, {
      action: 'stock.restocked_from_return',
      entityType: 'product',
      entityId: productId,
      oldState: { availableStock: product.availableStock, reservedStock: product.reservedStock },
      newState: {
        availableStock: stockAfter,
        // Untouched, and said so: returned goods are free stock, not re-committed stock.
        reservedStock: product.reservedStock,
        quantity,
        sku: product.sku,
        returnId,
        returnNumber: entry.returnNumber,
        salesOrderId: entry.salesOrderId,
      },
    });
  }

  const damaged = entry.items.reduce((sum, item) => sum + item.quantityDamaged, 0);
  const missing = entry.items.reduce((sum, item) => sum + item.quantityMissing, 0);

  await tx.return.update({
    where: { id: returnId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });

  await recordAudit(tx, context, {
    action: 'return.completed',
    entityType: 'return',
    entityId: returnId,
    oldState: { status: entry.status },
    newState: {
      status: 'COMPLETED',
      returnNumber: entry.returnNumber,
      orderNumber: entry.salesOrder.orderNumber,
      restocked: restocked.map((row) => ({ sku: row.sku, quantity: row.quantity })),
      damaged,
      missing,
      // Three facts a later dispute will turn on.
      reservationRecreated: false,
      paymentChanged: false,
      paymentStatus: entry.salesOrder.paymentStatus,
    },
  });

  return ok({ alreadyCompleted: false, restocked, damaged, missing });
}

/** Withdraws a return that is not going to happen. Moves no stock. */
export async function cancelReturn(
  tx: TenantTransaction,
  context: ActorContext,
  returnId: string,
  reason: string,
): Promise<Result<{ alreadyCancelled: boolean }>> {
  const entry = await loadReturnForMutation(tx, context, returnId);
  if (!entry) return fail('NOT_FOUND', 'error.notFound');

  if (entry.status === 'CANCELLED') return ok({ alreadyCancelled: true });
  if (!canTransitionReturn(entry.status as ReturnStatus, 'CANCELLED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      'The goods on this return have already been put back on the shelf.',
    );
  }
  if (!reason.trim()) return fail('VALIDATION_FAILED', 'Say why the return is being withdrawn.');

  await tx.return.update({
    where: { id: returnId },
    data: { status: 'CANCELLED', note: reason.trim() },
  });

  // The delivery's resolution is cleared with it, so the failure can be resolved another way.
  await tx.delivery.update({
    where: { id: entry.deliveryId },
    data: { failureResolution: null, resolvedById: null, resolvedAt: null },
  });

  await recordAudit(tx, context, {
    action: 'return.cancelled',
    entityType: 'return',
    entityId: returnId,
    oldState: { status: entry.status },
    newState: { status: 'CANCELLED', reason: reason.trim(), stockChanged: false },
  });

  return ok({ alreadyCancelled: false });
}

export { affectedByShortfall };
