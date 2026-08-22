import 'server-only';
import { z } from 'zod';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { isUuid } from '@/platform/ids';
import { type Result, fail, ok } from '@/platform/result';
import { recordAudit } from '@/modules/audit';
import { recordMovement } from '@/modules/inventory';
import { allocateDocumentNumber } from '@/modules/numbering';
import {
  type ConsumptionMismatch,
  describeMismatch,
  planConsumption,
} from './consumption';
import {
  type DeliveryFailureReason,
  type DeliveryStatus,
  DELIVERY_FAILURE_REASONS,
  type WarehouseTaskStatus,
  assessCompletion,
  assessEligibility,
  canTransitionDelivery,
  canTransitionTask,
} from './state';

export * from './state';
export * from './consumption';
export * from './queries';

/**
 * Warehouse fulfilment and delivery.
 *
 * ## Lock ordering
 *
 * Phases 4 and 5 established two partial orders — `payment → sales_order` for confirmation, and
 * `sales_order → products (ascending id)` for reservation and cancellation. Phase 6 needs to
 * touch tasks and deliveries as well, so it extends those into one total order rather than
 * inventing a second convention:
 *
 *     payment → sales_order → warehouse_task → delivery → products (ascending id)
 *
 * Every operation in this module takes the prefix it needs and skips the rest, always
 * left to right. That is a strict superset of what already existed, so no lock graph from an
 * earlier phase changes, and two operations from different phases racing over the same order
 * cannot take a pair of locks in opposite directions.
 *
 * Products are locked ascending by id, one statement per id — the Phase 4 rule, unchanged. A
 * single `ORDER BY … FOR UPDATE` would usually lock in the same sequence, and "usually" is not
 * a property to rest a deadlock guarantee on.
 */

/** Locks the order row. Always first among the row locks this module takes. */
async function lockOrderRow(
  tx: TenantTransaction,
  organizationId: string,
  salesOrderId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sales_orders
     WHERE id = ${salesOrderId}::uuid
       AND organization_id = ${organizationId}::uuid
     FOR UPDATE
  `;
  return rows.length > 0;
}

async function lockTaskRow(
  tx: TenantTransaction,
  organizationId: string,
  taskId: string,
): Promise<{ id: string; sales_order_id: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; sales_order_id: string }[]>`
    SELECT id, sales_order_id FROM warehouse_tasks
     WHERE id = ${taskId}::uuid
       AND organization_id = ${organizationId}::uuid
     FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockDeliveryRow(
  tx: TenantTransaction,
  organizationId: string,
  deliveryId: string,
): Promise<{ id: string; sales_order_id: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; sales_order_id: string }[]>`
    SELECT id, sales_order_id FROM deliveries
     WHERE id = ${deliveryId}::uuid
       AND organization_id = ${organizationId}::uuid
     FOR UPDATE
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Task creation
// ---------------------------------------------------------------------------

export interface CreatedTask {
  readonly id: string;
  readonly taskNumber: string;
  /** True when a task already existed and was returned instead of a second being raised. */
  readonly alreadyExisted: boolean;
}

/**
 * Raises the warehouse task for an order that is already eligible.
 *
 * Eligibility is read from the order's stored status columns via `assessEligibility`, which
 * does no payment arithmetic of its own. The warehouse module must never form its own opinion
 * about whether enough money arrived; Phase 5 owns that and writes the answer down.
 *
 * Idempotent. A double-clicked button, a retried request and two tabs all resolve to the one
 * task — checked here, and backed by a partial unique index for the case where both requests
 * check before either writes.
 */
export async function createWarehouseTask(
  tx: TenantTransaction,
  context: ActorContext,
  salesOrderId: string,
): Promise<Result<CreatedTask>> {
  if (!isUuid(salesOrderId)) return fail('NOT_FOUND', 'error.notFound');
  if (!(await lockOrderRow(tx, context.organizationId, salesOrderId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }

  const order = await tx.salesOrder.findFirst({
    where: { id: salesOrderId },
    include: {
      items: { orderBy: { sortOrder: 'asc' } },
      reservations: { where: { status: 'ACTIVE' } },
    },
  });
  if (!order) return fail('NOT_FOUND', 'error.notFound');

  // Idempotency, first line of defence. The partial unique index is the second, and the one
  // that holds when two requests arrive together.
  const existing = await tx.warehouseTask.findFirst({
    where: { salesOrderId, status: { not: 'CANCELLED' } },
  });
  if (existing) {
    return ok({ id: existing.id, taskNumber: existing.taskNumber, alreadyExisted: true });
  }

  const reservedLines = order.items.filter((item) => item.reservedQuantity > 0);

  const verdict = assessEligibility(
    {
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentType: order.paymentType as 'CASH' | 'CREDIT',
    },
    reservedLines.length,
  );

  if (!verdict.eligible) {
    return fail('INVALID_STATE_TRANSITION', verdict.detail, { refusal: verdict.refusal });
  }

  const taskNumber = await allocateDocumentNumber(tx, context.organizationId, 'WAREHOUSE_TASK');

  const task = await tx.warehouseTask.create({
    data: {
      organizationId: context.organizationId,
      taskNumber,
      salesOrderId,
      status: 'PENDING',
      createdById: context.userId,
    },
  });

  // Snapshots carried forward one more time. What the warehouse reads cannot be changed by
  // anyone editing the catalogue afterwards, which is the entire reason these rows exist
  // rather than a join back to the product table.
  for (const item of reservedLines) {
    await tx.warehouseTaskItem.create({
      data: {
        organizationId: context.organizationId,
        warehouseTaskId: task.id,
        salesOrderItemId: item.id,
        productId: item.productId,
        skuSnapshot: item.skuSnapshot,
        descriptionSnapshot: item.descriptionSnapshot,
        unitSnapshot: item.unitSnapshot,
        quantityRequired: item.reservedQuantity,
        quantityPrepared: 0,
        status: 'PENDING',
      },
    });
  }

  await recordAudit(tx, context, {
    action: 'warehouse_task.created',
    entityType: 'warehouse_task',
    entityId: task.id,
    newState: {
      taskNumber,
      salesOrderId,
      orderNumber: order.orderNumber,
      paymentType: order.paymentType,
      lines: reservedLines.length,
      // Recorded because "why was this allowed onto the floor" must be answerable later from
      // the log alone, without re-deriving the payment position as it was that day.
      eligibility: {
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
      },
    },
  });

  return ok({ id: task.id, taskNumber, alreadyExisted: false });
}

// ---------------------------------------------------------------------------
// Task progress
// ---------------------------------------------------------------------------

async function loadTaskForMutation(
  tx: TenantTransaction,
  context: ActorContext,
  taskId: string,
) {
  if (!isUuid(taskId)) return null;

  // Order first, then task — the module-wide ordering. Taking the task lock first would
  // reverse it against `createWarehouseTask` and against cancellation.
  const locked = await tx.$queryRaw<{ sales_order_id: string }[]>`
    SELECT sales_order_id FROM warehouse_tasks
     WHERE id = ${taskId}::uuid AND organization_id = ${context.organizationId}::uuid
  `;
  const salesOrderId = locked[0]?.sales_order_id;
  if (!salesOrderId) return null;

  if (!(await lockOrderRow(tx, context.organizationId, salesOrderId))) return null;
  if (!(await lockTaskRow(tx, context.organizationId, taskId))) return null;

  return tx.warehouseTask.findFirst({
    where: { id: taskId },
    include: {
      items: true,
      salesOrder: { include: { customer: true } },
    },
  });
}

/** PENDING → IN_PROGRESS. Records who picked it up and when. */
export async function startWarehouseTask(
  tx: TenantTransaction,
  context: ActorContext,
  taskId: string,
): Promise<Result<{ alreadyStarted: boolean }>> {
  const task = await loadTaskForMutation(tx, context, taskId);
  if (!task) return fail('NOT_FOUND', 'error.notFound');

  if (task.status === 'IN_PROGRESS') return ok({ alreadyStarted: true });

  if (!canTransitionTask(task.status as WarehouseTaskStatus, 'IN_PROGRESS')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This task is ${task.status.toLowerCase().replace(/_/g, ' ')} and cannot be started.`,
    );
  }

  await tx.warehouseTask.update({
    where: { id: taskId },
    data: {
      status: 'IN_PROGRESS',
      startedAt: new Date(),
      // Whoever starts it owns it, unless someone was already assigned by hand.
      assignedUserId: task.assignedUserId ?? context.userId,
    },
  });

  await recordAudit(tx, context, {
    action: 'warehouse_task.started',
    entityType: 'warehouse_task',
    entityId: taskId,
    oldState: { status: task.status },
    newState: { status: 'IN_PROGRESS', orderNumber: task.salesOrder.orderNumber },
  });

  return ok({ alreadyStarted: false });
}

/**
 * Marks one line picked, in full.
 *
 * There is no quantity parameter, deliberately. Phase 6 has no partial fulfilment, and an API
 * that accepts "8 of 12" is an API that will eventually be used to ship 8 of 12. A line that
 * cannot be picked in full leaves the task unfinished and a person deals with it.
 */
export async function markItemPrepared(
  tx: TenantTransaction,
  context: ActorContext,
  taskId: string,
  itemId: string,
  prepared: boolean,
): Promise<Result<{ preparedCount: number; totalCount: number }>> {
  if (!isUuid(itemId)) return fail('NOT_FOUND', 'error.notFound');

  const task = await loadTaskForMutation(tx, context, taskId);
  if (!task) return fail('NOT_FOUND', 'error.notFound');

  if (task.status !== 'IN_PROGRESS') {
    return fail(
      'INVALID_STATE_TRANSITION',
      'Start the task before marking lines picked.',
    );
  }

  const item = task.items.find((candidate) => candidate.id === itemId);
  if (!item) return fail('NOT_FOUND', 'error.notFound');

  await tx.warehouseTaskItem.update({
    where: { id: itemId },
    data: {
      status: prepared ? 'PREPARED' : 'PENDING',
      quantityPrepared: prepared ? item.quantityRequired : 0,
    },
  });

  const items = await tx.warehouseTaskItem.findMany({ where: { warehouseTaskId: taskId } });
  const preparedCount = items.filter((candidate) => candidate.status === 'PREPARED').length;

  await recordAudit(tx, context, {
    action: prepared ? 'warehouse_task.item_prepared' : 'warehouse_task.item_unprepared',
    entityType: 'warehouse_task',
    entityId: taskId,
    newState: {
      sku: item.skuSnapshot,
      quantity: item.quantityRequired,
      unit: item.unitSnapshot,
      preparedCount,
      totalCount: items.length,
    },
  });

  return ok({ preparedCount, totalCount: items.length });
}

/** IN_PROGRESS → PREPARED. Requires every line picked. Still moves no inventory. */
export async function markTaskPrepared(
  tx: TenantTransaction,
  context: ActorContext,
  taskId: string,
): Promise<Result<{ alreadyPrepared: boolean }>> {
  const task = await loadTaskForMutation(tx, context, taskId);
  if (!task) return fail('NOT_FOUND', 'error.notFound');

  if (task.status === 'PREPARED') return ok({ alreadyPrepared: true });

  if (!canTransitionTask(task.status as WarehouseTaskStatus, 'PREPARED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This task is ${task.status.toLowerCase().replace(/_/g, ' ')} and cannot be marked prepared.`,
    );
  }

  const outstanding = task.items.filter((item) => item.status !== 'PREPARED');
  if (outstanding.length > 0) {
    return fail(
      'CONFLICT',
      `${outstanding.length} line${outstanding.length === 1 ? '' : 's'} still to pick.`,
      { outstanding: outstanding.map((item) => item.skuSnapshot) },
    );
  }

  await tx.warehouseTask.update({
    where: { id: taskId },
    data: { status: 'PREPARED', preparedAt: new Date() },
  });

  await recordAudit(tx, context, {
    action: 'warehouse_task.prepared',
    entityType: 'warehouse_task',
    entityId: taskId,
    oldState: { status: task.status },
    newState: {
      status: 'PREPARED',
      orderNumber: task.salesOrder.orderNumber,
      // Stated in the log because it is the thing most easily misread from the outside: the
      // goods are picked and still counted as being in the yard.
      inventoryMoved: false,
    },
  });

  return ok({ alreadyPrepared: false });
}

// ---------------------------------------------------------------------------
// Completion — the only operation in the product that consumes stock
// ---------------------------------------------------------------------------

export interface CompletionResult {
  readonly alreadyCompleted: boolean;
  readonly consumed: readonly { productId: string; sku: string; quantity: number }[];
  readonly deliveryId: string | null;
  readonly deliveryNumber: string | null;
  readonly orderCompleted: boolean;
}

/**
 * PREPARED → COMPLETED. Goods leave warehouse custody, and stock is consumed.
 *
 * **The boundary is here, not at PREPARED.** Picking assembles goods that are still on the
 * premises and still counted; a task that is picked and then cancelled costs a walk back to the
 * shelf and no correction. Completion is the moment custody changes, which is the moment the
 * physical count actually changes. Consuming at PREPARED would show stock leaving while it is
 * demonstrably still in the yard, and every stock count would disagree with the system for as
 * long as the goods sat by the door.
 *
 * The sequence, all in one transaction:
 *
 *   1. lock the order, then the task — the module-wide ordering
 *   2. lock the products this task touches, ascending by id
 *   3. re-derive the required quantities and the live reservations *inside* the locks
 *   4. refuse on any mismatch, without repairing anything
 *   5. decrement `available_stock` and `reserved_stock` together
 *   6. move the reservations ACTIVE → CONSUMED
 *   7. complete the task, create the delivery if one is required
 *   8. complete the order if nothing else is outstanding
 *   9. audit, with before and after figures for every product
 *
 * Step 3 is what makes it safe under concurrency: two completions against the same order are
 * serialised by the task lock, and the second finds its reservations already CONSUMED rather
 * than ACTIVE, so it consumes nothing a second time.
 */
export async function completeWarehouseTask(
  tx: TenantTransaction,
  context: ActorContext,
  taskId: string,
): Promise<Result<CompletionResult>> {
  const task = await loadTaskForMutation(tx, context, taskId);
  if (!task) return fail('NOT_FOUND', 'error.notFound');

  if (task.status === 'COMPLETED') {
    const existingDelivery = await tx.delivery.findFirst({ where: { warehouseTaskId: taskId } });
    return ok({
      alreadyCompleted: true,
      consumed: [],
      deliveryId: existingDelivery?.id ?? null,
      deliveryNumber: existingDelivery?.deliveryNumber ?? null,
      orderCompleted: task.salesOrder.status === 'COMPLETED',
    });
  }

  if (!canTransitionTask(task.status as WarehouseTaskStatus, 'COMPLETED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This task is ${task.status.toLowerCase().replace(/_/g, ' ')}. Only a prepared task can be handed over.`,
    );
  }

  const order = task.salesOrder;
  if (order.status !== 'OPEN') {
    return fail(
      'CONFLICT',
      `Order ${order.orderNumber} is ${order.status.toLowerCase()}, so nothing can be handed over against it.`,
      undefined,
      true,
    );
  }

  // --- lock every product this task touches, ascending by id ---------------
  const productIds = [
    ...new Set(task.items.map((item) => item.productId).filter((id): id is string => id !== null)),
  ].sort();

  if (productIds.length !== task.items.length) {
    return fail(
      'CONFLICT',
      'A product on this task is no longer in the catalogue, so the handover cannot be recorded against it.',
      undefined,
      true,
    );
  }

  /*
   * Phase 7. Lock this task's open discrepancies, then check them.
   *
   * Locked *before* the products, which keeps the module-wide ordering intact — discrepancy sits
   * between delivery and products in the chain — and is what makes a handover racing a
   * reconciliation serialise rather than interleave. Whichever arrives second sees what the
   * first did.
   *
   * A reported count is an unresolved disagreement about how much is really there. Handing goods
   * over while one stands would consume against a figure somebody has already said is wrong.
   */
  const blocking = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM inventory_discrepancies
     WHERE warehouse_task_id = ${taskId}::uuid
       AND organization_id = ${context.organizationId}::uuid
       AND status IN ('OPEN', 'UNDER_REVIEW')
     ORDER BY id
     FOR UPDATE
  `;

  if (blocking.length > 0) {
    const open = await tx.inventoryDiscrepancy.findMany({
      where: { id: { in: blocking.map((row) => row.id) } },
      include: { product: { select: { sku: true, name: true, unit: true } } },
    });
    const first = open[0]!;

    return fail(
      'CONFLICT',
      `${first.discrepancyNumber} is open against ${first.product.name} (${first.product.sku}): ${first.systemOnHandQuantity} ${first.product.unit} recorded, ${first.physicalCountQuantity} counted. It has to be reconciled before these goods can leave.`,
      {
        discrepancies: open.map((row) => ({
          id: row.id,
          discrepancyNumber: row.discrepancyNumber,
          sku: row.product.sku,
          description: row.product.name,
          unit: row.product.unit,
          systemOnHand: row.systemOnHandQuantity,
          physicalCount: row.physicalCountQuantity,
          variance: row.varianceQuantity,
        })),
      },
      true,
    );
  }

  for (const productId of productIds) {
    await tx.$executeRaw`
      SELECT id FROM products
       WHERE id = ${productId}::uuid
         AND organization_id = ${context.organizationId}::uuid
       FOR UPDATE
    `;
  }

  // --- re-derive everything inside the locks -------------------------------
  const reservations = await tx.stockReservation.findMany({ where: { salesOrderId: order.id } });
  const products = await tx.product.findMany({ where: { id: { in: productIds } } });

  const organizationActive = await tx.stockReservation.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds }, status: 'ACTIVE' },
    _sum: { quantity: true },
  });
  const organizationActiveByProduct = new Map(
    organizationActive.map((row) => [row.productId, row._sum.quantity ?? 0]),
  );

  const plan = planConsumption(
    task.items.map((item) => ({
      productId: item.productId!,
      sku: item.skuSnapshot,
      description: item.descriptionSnapshot,
      unit: item.unitSnapshot,
      quantity: item.quantityRequired,
    })),
    reservations.map((reservation) => ({
      id: reservation.id,
      productId: reservation.productId,
      quantity: reservation.quantity,
      status: reservation.status,
    })),
    products.map((product) => ({
      productId: product.id,
      sku: product.sku,
      availableStock: product.availableStock,
      reservedStock: product.reservedStock,
    })),
    organizationActiveByProduct,
  );

  if (!plan.satisfiable) {
    // Refused, and nothing repaired. A mismatch at this point is an invariant violation and
    // the correct response is a person with a clipboard, not an automatic adjustment.
    await recordAudit(tx, context, {
      action: 'warehouse_task.completion_refused_reservation_mismatch',
      entityType: 'warehouse_task',
      entityId: taskId,
      newState: {
        orderNumber: order.orderNumber,
        mismatches: plan.mismatches.map((mismatch) => ({
          kind: mismatch.kind,
          sku: mismatch.sku,
          expected: mismatch.expected,
          actual: mismatch.actual,
        })),
      },
    });

    return fail(
      'CONFLICT',
      describeMismatch(plan.mismatches[0]!),
      { mismatches: plan.mismatches as unknown as ConsumptionMismatch[] },
      true,
    );
  }

  const stockByProduct = new Map(products.map((product) => [product.id, product]));
  const completedAt = new Date();
  const consumed: { productId: string; sku: string; quantity: number }[] = [];

  for (const productId of productIds) {
    const product = stockByProduct.get(productId)!;
    const quantity = plan.byProduct.get(productId) ?? 0;

    await tx.$executeRaw`
      UPDATE products
         SET available_stock = available_stock - ${quantity},
             reserved_stock  = reserved_stock  - ${quantity},
             updated_at = now()
       WHERE id = ${productId}::uuid
         AND organization_id = ${context.organizationId}::uuid
    `;

    consumed.push({ productId, sku: product.sku, quantity });

    /*
     * Phase 7. The same event, in the ledger that explains stock.
     *
     * Added as history, not as a change of behaviour: the decrement above is Phase 6's and is
     * untouched. Before this, a manual correction was recorded in one place and a shipment in
     * another, so no single query could answer "why did Rebar 12mm decrease by 40".
     */
    await recordMovement(tx, context, {
      productId,
      movementType: 'FULFILLMENT_CONSUMPTION',
      delta: -quantity,
      stockAfter: product.availableStock - quantity,
      reason: `${task.taskNumber}: handed over against ${order.orderNumber}`,
      relatedOrderId: order.id,
      relatedReservationId:
        reservations.find(
          (reservation) => reservation.productId === productId && reservation.status === 'ACTIVE',
        )?.id ?? null,
    });

    // The one audit event a stock dispute will be settled from. Structured, with both figures
    // before and after, and tied to the order and the reservations that justified it.
    await recordAudit(tx, context, {
      action: 'stock.consumed_by_fulfillment',
      entityType: 'product',
      entityId: productId,
      oldState: {
        availableStock: product.availableStock,
        reservedStock: product.reservedStock,
      },
      newState: {
        availableStock: product.availableStock - quantity,
        reservedStock: product.reservedStock - quantity,
        quantity,
        sku: product.sku,
        salesOrderId: order.id,
        orderNumber: order.orderNumber,
        warehouseTaskId: taskId,
        reservationIds: reservations
          .filter((reservation) => reservation.productId === productId && reservation.status === 'ACTIVE')
          .map((reservation) => reservation.id),
      },
    });
  }

  for (const reservationId of plan.reservationIds) {
    await tx.stockReservation.update({
      where: { id: reservationId },
      data: { status: 'CONSUMED', releasedAt: completedAt },
    });
  }

  await recordAudit(tx, context, {
    action: 'reservation.consumed',
    entityType: 'sales_order',
    entityId: order.id,
    newState: {
      warehouseTaskId: taskId,
      reservationIds: plan.reservationIds,
      consumed: consumed.map((row) => ({ sku: row.sku, quantity: row.quantity })),
    },
  });

  await tx.warehouseTask.update({
    where: { id: taskId },
    data: { status: 'COMPLETED', completedAt },
  });

  await recordAudit(tx, context, {
    action: 'warehouse_task.completed',
    entityType: 'warehouse_task',
    entityId: taskId,
    oldState: { status: task.status },
    newState: {
      status: 'COMPLETED',
      orderNumber: order.orderNumber,
      inventoryMoved: true,
    },
  });

  // --- the delivery, if this order needs one -------------------------------
  let deliveryId: string | null = null;
  let deliveryNumber: string | null = null;

  if (order.deliveryRequired) {
    const destination =
      order.deliveryAddressSnapshot?.trim() || order.customer.address?.trim() || '';

    if (!destination) {
      return fail(
        'VALIDATION_FAILED',
        `Order ${order.orderNumber} needs delivery but has no address recorded, so a delivery cannot be raised.`,
      );
    }

    deliveryNumber = await allocateDocumentNumber(tx, context.organizationId, 'DELIVERY');

    // Snapshotted here and never read live again. A delivery record is history, and history
    // that rewrites itself when someone edits a customer's phone number is not history.
    const delivery = await tx.delivery.create({
      data: {
        organizationId: context.organizationId,
        deliveryNumber,
        salesOrderId: order.id,
        warehouseTaskId: taskId,
        status: 'PENDING',
        customerNameSnapshot: order.customer.companyName,
        customerPhoneSnapshot: order.customer.phone,
        destinationTextSnapshot: destination,
      },
    });
    deliveryId = delivery.id;

    await recordAudit(tx, context, {
      action: 'delivery.created',
      entityType: 'delivery',
      entityId: delivery.id,
      newState: {
        deliveryNumber,
        orderNumber: order.orderNumber,
        salesOrderId: order.id,
        destination,
      },
    });
  }

  // --- does the order finish here? -----------------------------------------
  const orderCompleted = await maybeCompleteOrder(tx, context, order.id);

  return {
    ok: true,
    value: {
      alreadyCompleted: false,
      consumed,
      deliveryId,
      deliveryNumber,
      orderCompleted,
    },
  };
}

// ---------------------------------------------------------------------------
// Order completion
// ---------------------------------------------------------------------------

/**
 * Completes the order when everything operational is done, and does nothing otherwise.
 *
 * Called from every path that could be the last one — warehouse completion, delivery
 * completion, pickup — rather than from one of them, because which one is last depends on the
 * order and on the day.
 *
 * Assumes the order row is already locked by the caller.
 */
async function maybeCompleteOrder(
  tx: TenantTransaction,
  context: ActorContext,
  salesOrderId: string,
): Promise<boolean> {
  const order = await tx.salesOrder.findFirst({
    where: { id: salesOrderId },
    include: {
      warehouseTasks: { where: { status: { not: 'CANCELLED' } } },
      deliveries: { where: { status: { notIn: ['CANCELLED', 'FAILED'] } } },
    },
  });
  if (!order || order.status !== 'OPEN') return false;

  const task = order.warehouseTasks[0];
  const delivery = order.deliveries[0];

  const verdict = assessCompletion({
    paymentType: order.paymentType as 'CASH' | 'CREDIT',
    paymentStatus: order.paymentStatus,
    deliveryRequired: order.deliveryRequired,
    warehouseTaskStatus: (task?.status as WarehouseTaskStatus | undefined) ?? null,
    deliveryStatus: (delivery?.status as DeliveryStatus | undefined) ?? null,
    pickedUp: order.pickedUpAt !== null,
  });

  if (!verdict.complete) return false;

  const completedAt = new Date();
  await tx.salesOrder.update({
    where: { id: salesOrderId },
    data: { status: 'COMPLETED', completedAt },
  });

  await recordAudit(tx, context, {
    action: 'order.completed',
    entityType: 'sales_order',
    entityId: salesOrderId,
    oldState: { status: 'OPEN' },
    newState: {
      status: 'COMPLETED',
      orderNumber: order.orderNumber,
      via: order.deliveryRequired ? 'delivery' : 'pickup',
      /*
       * Recorded explicitly, because this is the fact most likely to be misread later.
       *
       * Operational completion is about goods, not money. A credit order delivered today with
       * 30-day terms is COMPLETED and still owes its full balance; it stays in receivables
       * until Finance confirms a payment. Nothing on this path touches paymentStatus.
       */
      paymentStatus: order.paymentStatus,
      paymentSettled: order.paymentStatus === 'PAID',
    },
  });

  return true;
}

// ---------------------------------------------------------------------------
// Pickup
// ---------------------------------------------------------------------------

/**
 * Records that the customer collected the goods themselves.
 *
 * Only for an order that needs no delivery. Creating a Delivery row for someone who drove to
 * the yard would make the delivery queue claim there is a vehicle on the road, which is exactly
 * the sort of small lie that makes an operational screen stop being trusted.
 */
export async function recordPickup(
  tx: TenantTransaction,
  context: ActorContext,
  salesOrderId: string,
  note: string | null,
): Promise<Result<{ alreadyRecorded: boolean; orderCompleted: boolean }>> {
  if (!isUuid(salesOrderId)) return fail('NOT_FOUND', 'error.notFound');
  if (!(await lockOrderRow(tx, context.organizationId, salesOrderId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }

  const order = await tx.salesOrder.findFirst({
    where: { id: salesOrderId },
    include: { warehouseTasks: { where: { status: { not: 'CANCELLED' } } } },
  });
  if (!order) return fail('NOT_FOUND', 'error.notFound');

  if (order.pickedUpAt) {
    return ok({ alreadyRecorded: true, orderCompleted: order.status === 'COMPLETED' });
  }

  if (order.deliveryRequired) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `Order ${order.orderNumber} is marked for delivery, so it is completed by the delivery rather than by collection.`,
    );
  }

  const task = order.warehouseTasks[0];
  if (task?.status !== 'COMPLETED') {
    return fail(
      'INVALID_STATE_TRANSITION',
      'The warehouse has not handed these goods over yet, so a collection cannot be recorded.',
    );
  }

  await tx.salesOrder.update({
    where: { id: salesOrderId },
    data: {
      pickedUpAt: new Date(),
      pickedUpById: context.userId,
      pickupNote: note?.trim() || null,
    },
  });

  await recordAudit(tx, context, {
    action: 'order.picked_up',
    entityType: 'sales_order',
    entityId: salesOrderId,
    newState: { orderNumber: order.orderNumber, note: note?.trim() || null },
  });

  const orderCompleted = await maybeCompleteOrder(tx, context, salesOrderId);
  return ok({ alreadyRecorded: false, orderCompleted });
}

// ---------------------------------------------------------------------------
// Task cancellation
// ---------------------------------------------------------------------------

/**
 * Cancels a task that has not yet handed goods over.
 *
 * A COMPLETED task cannot be cancelled, because cancelling it would have to mean putting stock
 * back, and stock that has left the yard does not come back because a row changed.
 */
export async function cancelWarehouseTask(
  tx: TenantTransaction,
  context: ActorContext,
  taskId: string,
  reason: string,
): Promise<Result<{ alreadyCancelled: boolean }>> {
  const task = await loadTaskForMutation(tx, context, taskId);
  if (!task) return fail('NOT_FOUND', 'error.notFound');

  if (task.status === 'CANCELLED') return ok({ alreadyCancelled: true });

  if (!canTransitionTask(task.status as WarehouseTaskStatus, 'CANCELLED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      'The goods for this task have already left the warehouse, so it cannot be cancelled.',
    );
  }

  if (!reason.trim()) {
    return fail('VALIDATION_FAILED', 'Say why the task is being cancelled.');
  }

  await tx.warehouseTask.update({
    where: { id: taskId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancellationReason: reason.trim(),
    },
  });

  await recordAudit(tx, context, {
    action: 'warehouse_task.cancelled',
    entityType: 'warehouse_task',
    entityId: taskId,
    oldState: { status: task.status },
    newState: {
      status: 'CANCELLED',
      reason: reason.trim(),
      orderNumber: task.salesOrder.orderNumber,
      // The reservations stay ACTIVE: the order still exists and still owns its stock.
      reservationsReleased: false,
    },
  });

  return ok({ alreadyCancelled: false });
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export const assignDeliverySchema = z.object({
  driverName: z.string().trim().min(1).max(120),
  driverPhone: z.string().trim().max(40).optional().or(z.literal('')),
  vehicleReference: z.string().trim().max(60).optional().or(z.literal('')),
});

async function loadDeliveryForMutation(
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

  // order → delivery, the module-wide ordering. Completion updates the order too.
  if (!(await lockOrderRow(tx, context.organizationId, salesOrderId))) return null;
  if (!(await lockDeliveryRow(tx, context.organizationId, deliveryId))) return null;

  return tx.delivery.findFirst({
    where: { id: deliveryId },
    include: { salesOrder: true, warehouseTask: true },
  });
}

export async function assignDelivery(
  tx: TenantTransaction,
  context: ActorContext,
  deliveryId: string,
  raw: unknown,
): Promise<Result<null>> {
  const parsed = assignDeliverySchema.safeParse(raw);
  if (!parsed.success) return fail('VALIDATION_FAILED', 'A driver name is required.');

  const delivery = await loadDeliveryForMutation(tx, context, deliveryId);
  if (!delivery) return fail('NOT_FOUND', 'error.notFound');

  if (delivery.status !== 'PENDING' && delivery.status !== 'ASSIGNED') {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This delivery is ${delivery.status.toLowerCase()} and cannot be reassigned.`,
    );
  }

  await tx.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'ASSIGNED',
      assignedDriverName: parsed.data.driverName,
      assignedDriverPhone: parsed.data.driverPhone?.trim() || null,
      vehicleReference: parsed.data.vehicleReference?.trim() || null,
      assignedAt: new Date(),
    },
  });

  await recordAudit(tx, context, {
    action: 'delivery.assigned',
    entityType: 'delivery',
    entityId: deliveryId,
    oldState: { status: delivery.status, driver: delivery.assignedDriverName },
    newState: {
      status: 'ASSIGNED',
      driver: parsed.data.driverName,
      vehicle: parsed.data.vehicleReference?.trim() || null,
      deliveryNumber: delivery.deliveryNumber,
    },
  });

  return ok(null);
}

/**
 * Records that the goods went out on the road.
 *
 * Requires the warehouse to have completed — which is what guarantees the stock has actually
 * been consumed. Dispatching before that would put a vehicle on the road carrying goods the
 * system still believes are in the yard.
 */
export async function dispatchDelivery(
  tx: TenantTransaction,
  context: ActorContext,
  deliveryId: string,
): Promise<Result<{ alreadyDispatched: boolean }>> {
  const delivery = await loadDeliveryForMutation(tx, context, deliveryId);
  if (!delivery) return fail('NOT_FOUND', 'error.notFound');

  if (delivery.status === 'DISPATCHED') return ok({ alreadyDispatched: true });

  if (!canTransitionDelivery(delivery.status as DeliveryStatus, 'DISPATCHED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This delivery is ${delivery.status.toLowerCase()} and cannot be dispatched.`,
    );
  }

  if (delivery.warehouseTask.status !== 'COMPLETED') {
    return fail(
      'CONFLICT',
      'The warehouse has not handed these goods over yet, so nothing can be dispatched.',
      undefined,
      true,
    );
  }

  if (delivery.salesOrder.status === 'CANCELLED') {
    return fail('CONFLICT', 'This order was cancelled.', undefined, true);
  }

  await tx.delivery.update({
    where: { id: deliveryId },
    data: { status: 'DISPATCHED', dispatchedAt: new Date() },
  });

  await recordAudit(tx, context, {
    action: 'delivery.dispatched',
    entityType: 'delivery',
    entityId: deliveryId,
    oldState: { status: delivery.status },
    newState: {
      status: 'DISPATCHED',
      deliveryNumber: delivery.deliveryNumber,
      orderNumber: delivery.salesOrder.orderNumber,
      driver: delivery.assignedDriverName,
    },
  });

  return ok({ alreadyDispatched: false });
}

/**
 * Records that staff say the goods arrived.
 *
 * Deliberately phrased that way everywhere it surfaces. There is no signature, no photo and no
 * customer confirmation in this product, so calling it proof of delivery would be a claim the
 * software cannot support — and the moment it is disputed, that claim is what gets read back.
 */
export async function completeDelivery(
  tx: TenantTransaction,
  context: ActorContext,
  deliveryId: string,
  note: string | null,
): Promise<Result<{ alreadyDelivered: boolean; orderCompleted: boolean }>> {
  const delivery = await loadDeliveryForMutation(tx, context, deliveryId);
  if (!delivery) return fail('NOT_FOUND', 'error.notFound');

  if (delivery.status === 'DELIVERED') {
    return ok({
      alreadyDelivered: true,
      orderCompleted: delivery.salesOrder.status === 'COMPLETED',
    });
  }

  if (!canTransitionDelivery(delivery.status as DeliveryStatus, 'DELIVERED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This delivery is ${delivery.status.toLowerCase()} and cannot be marked delivered.`,
    );
  }

  await tx.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'DELIVERED',
      deliveredAt: new Date(),
      deliveryNote: note?.trim() || null,
    },
  });

  await recordAudit(tx, context, {
    action: 'delivery.completed',
    entityType: 'delivery',
    entityId: deliveryId,
    oldState: { status: delivery.status },
    newState: {
      status: 'DELIVERED',
      deliveryNumber: delivery.deliveryNumber,
      orderNumber: delivery.salesOrder.orderNumber,
      note: note?.trim() || null,
      // Not proof of delivery. Recorded as what it is: a staff member said so.
      basis: 'marked completed by staff',
    },
  });

  const orderCompleted = await maybeCompleteOrder(tx, context, delivery.salesOrderId);
  return ok({ alreadyDelivered: false, orderCompleted });
}

/**
 * Records that a dispatched delivery did not arrive.
 *
 * **Nothing is returned to stock.** The goods left the yard and are somewhere — on the lorry,
 * at the wrong gate, refused at the door. Putting the quantity back would invent inventory that
 * nobody has counted, and it would do so at the precise moment the count matters. A return is a
 * separate physical event with its own record, and it does not exist yet.
 */
export async function failDelivery(
  tx: TenantTransaction,
  context: ActorContext,
  deliveryId: string,
  reason: DeliveryFailureReason,
  note: string | null,
): Promise<Result<{ alreadyFailed: boolean }>> {
  if (!DELIVERY_FAILURE_REASONS.includes(reason)) {
    return fail('VALIDATION_FAILED', 'Choose why the delivery failed.');
  }

  const delivery = await loadDeliveryForMutation(tx, context, deliveryId);
  if (!delivery) return fail('NOT_FOUND', 'error.notFound');

  if (delivery.status === 'FAILED') return ok({ alreadyFailed: true });

  if (!canTransitionDelivery(delivery.status as DeliveryStatus, 'FAILED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This delivery is ${delivery.status.toLowerCase()} and cannot be marked failed.`,
    );
  }

  await tx.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      failureReason: reason,
      failureNote: note?.trim() || null,
    },
  });

  await recordAudit(tx, context, {
    action: 'delivery.failed',
    entityType: 'delivery',
    entityId: deliveryId,
    oldState: { status: delivery.status },
    newState: {
      status: 'FAILED',
      reason,
      note: note?.trim() || null,
      deliveryNumber: delivery.deliveryNumber,
      orderNumber: delivery.salesOrder.orderNumber,
      // Stated in the log, because the absence of a restock is the thing someone will look for.
      stockRestored: false,
    },
  });

  return ok({ alreadyFailed: false });
}
