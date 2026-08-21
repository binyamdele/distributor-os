import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { cancelOrder } from '@/modules/orders';
import { orderBalance, receivables } from '@/modules/payments';
import {
  assignDelivery,
  cancelWarehouseTask,
  completeDelivery,
  completeWarehouseTask,
  createWarehouseTask,
  deliveryQueue,
  dispatchDelivery,
  failDelivery,
  fulfillmentForOrder,
  getDelivery,
  getWarehouseTask,
  markItemPrepared,
  markTaskPrepared,
  ordersAwaitingWarehouse,
  recordPickup,
  startWarehouseTask,
  warehouseQueue,
} from '@/modules/fulfillment';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { restoreFileStore, useMemoryFileStore } from '../support/payment-fixtures';
import { backdateDueDate } from '../support/payment-fixtures';
import {
  assertStockInvariants,
  fulfillableOrder,
  stockOf,
} from '../support/fulfillment-fixtures';

/**
 * Phase 6 against a real PostgreSQL.
 *
 * The unit tests pin the state machines and the consumption arithmetic. What can only be proved
 * here is that stock leaves exactly once under concurrency, that a reservation becomes CONSUMED
 * and never becomes anything else afterwards, that the row-level policies hold, and that
 * delivering a credit order does not quietly settle it.
 */

/** Walks an eligible order all the way to a completed warehouse handover. */
async function handedOver(
  org: Awaited<ReturnType<typeof seedOrg>>,
  options: Parameters<typeof fulfillableOrder>[2] = {},
) {
  const order = await fulfillableOrder(org.organizationId, org.context, options);

  const created = await withTenant(org.organizationId, (tx) =>
    createWarehouseTask(tx, org.context, order.orderId),
  );
  if (!created.ok) throw new Error(`task creation failed: ${created.error.message}`);
  const taskId = created.value.id;

  await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));

  const items = await owner.warehouseTaskItem.findMany({ where: { warehouseTaskId: taskId } });
  for (const item of items) {
    await withTenant(org.organizationId, (tx) =>
      markItemPrepared(tx, org.context, taskId, item.id, true),
    );
  }
  await withTenant(org.organizationId, (tx) => markTaskPrepared(tx, org.context, taskId));

  const completed = await withTenant(org.organizationId, (tx) =>
    completeWarehouseTask(tx, org.context, taskId),
  );
  if (!completed.ok) throw new Error(`handover failed: ${completed.error.message}`);

  return { order, taskId, completion: completed.value };
}

describe('raising a warehouse task', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('is allowed for a cash order whose payment was confirmed in full', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.paymentStatus).toBe('PAID');
    expect(row.fulfillmentStatus).toBe('READY');

    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.taskNumber).toMatch(/^WT-\d{6}$/);
    expect(created.value.alreadyExisted).toBe(false);

    const task = await owner.warehouseTask.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(task.status).toBe('PENDING');

    // The task carries snapshot rows, not a join back to the catalogue.
    const items = await owner.warehouseTaskItem.findMany({ where: { warehouseTaskId: task.id } });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.skuSnapshot).toBeTruthy();
      expect(item.unitSnapshot).toBeTruthy();
      expect(item.quantityRequired).toBeGreaterThan(0);
      expect(item.quantityPrepared).toBe(0);
    }

    // Nothing physical moved.
    await assertStockInvariants(org.organizationId);
  });

  it('is refused for a cash order nobody has paid', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, { leaveUnpaid: true });

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.paymentStatus).toBe('UNPAID');
    expect(row.fulfillmentStatus).toBe('NOT_READY');

    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(created.error.details?.refusal).toBe('FULFILLMENT_NOT_READY');
    }
    expect(await owner.warehouseTask.count()).toBe(0);
  });

  it('is refused for a partly paid cash order', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, { payFraction: 0.5 });

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.paymentStatus).toBe('PARTIALLY_PAID');
    expect(row.fulfillmentStatus).toBe('NOT_READY');

    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    expect(created.ok).toBe(false);
    expect(await owner.warehouseTask.count()).toBe(0);
  });

  it('is allowed for a credit order with nothing paid', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
      paymentTermsDays: 30,
    });

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.paymentStatus).toBe('NOT_REQUIRED_YET');
    expect(row.fulfillmentStatus).toBe('READY');

    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    expect(created.ok).toBe(true);
  });

  it('is idempotent — two clicks make one task', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);

    const first = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    const second = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.alreadyExisted).toBe(true);
    expect(second.value.id).toBe(first.value.id);
    expect(await owner.warehouseTask.count()).toBe(1);
  });

  it('refuses a second active task at the database even if the check were bypassed', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);
    const first = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    expect(first.ok).toBe(true);

    await expect(
      owner.warehouseTask.create({
        data: {
          organizationId: org.organizationId,
          taskNumber: 'WT-999999',
          salesOrderId: order.orderId,
          status: 'PENDING',
        },
      }),
    ).rejects.toThrow();
  });

  it('allows a replacement once the first task is cancelled', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);
    const first = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!first.ok) return;

    await withTenant(org.organizationId, (tx) =>
      cancelWarehouseTask(tx, org.context, first.value.id, 'picked the wrong bay'),
    );

    const second = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.id).not.toBe(first.value.id);
  });

  it('lists an eligible order as awaiting the warehouse, and drops it once raised', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);

    const before = await withTenant(org.organizationId, (tx) => ordersAwaitingWarehouse(tx));
    expect(before.map((row) => row.id)).toContain(order.orderId);

    await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );

    const after = await withTenant(org.organizationId, (tx) => ordersAwaitingWarehouse(tx));
    expect(after.map((row) => row.id)).not.toContain(order.orderId);
  });

  it('never offers an unpaid cash order in that list', async () => {
    await fulfillableOrder(org.organizationId, org.context, { leaveUnpaid: true });
    const rows = await withTenant(org.organizationId, (tx) => ordersAwaitingWarehouse(tx));
    expect(rows).toHaveLength(0);
  });
});

describe('picking', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  async function pendingTask() {
    const order = await fulfillableOrder(org.organizationId, org.context);
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) throw new Error(created.error.message);
    return { order, taskId: created.value.id };
  }

  it('records who started it and when', async () => {
    const { taskId } = await pendingTask();

    const started = await withTenant(org.organizationId, (tx) =>
      startWarehouseTask(tx, org.context, taskId),
    );
    expect(started.ok).toBe(true);

    const task = await owner.warehouseTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('IN_PROGRESS');
    expect(task.startedAt).not.toBeNull();
    expect(task.assignedUserId).toBe(org.userId);
  });

  it('will not mark a line picked before the task is started', async () => {
    const { taskId } = await pendingTask();
    const item = await owner.warehouseTaskItem.findFirstOrThrow({
      where: { warehouseTaskId: taskId },
    });

    const result = await withTenant(org.organizationId, (tx) =>
      markItemPrepared(tx, org.context, taskId, item.id, true),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses to mark the task prepared while a line is outstanding', async () => {
    const { taskId } = await pendingTask();
    await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));

    const result = await withTenant(org.organizationId, (tx) =>
      markTaskPrepared(tx, org.context, taskId),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
  });

  it('marks a line picked in full, never partly', async () => {
    const { taskId } = await pendingTask();
    await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));

    const item = await owner.warehouseTaskItem.findFirstOrThrow({
      where: { warehouseTaskId: taskId },
    });
    await withTenant(org.organizationId, (tx) =>
      markItemPrepared(tx, org.context, taskId, item.id, true),
    );

    const after = await owner.warehouseTaskItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('PREPARED');
    expect(after.quantityPrepared).toBe(after.quantityRequired);
  });

  it('will not let a partial quantity be written even around the module', async () => {
    // The database refuses it too. Phase 6 has no split shipment, and the cheapest way to keep
    // it that way is to make a partial quantity unrepresentable.
    const { taskId } = await pendingTask();
    const item = await owner.warehouseTaskItem.findFirstOrThrow({
      where: { warehouseTaskId: taskId },
    });

    await expect(
      owner.warehouseTaskItem.update({
        where: { id: item.id },
        data: { status: 'PREPARED', quantityPrepared: item.quantityRequired - 1 },
      }),
    ).rejects.toThrow();
  });

  it('moves no inventory when the task is marked prepared', async () => {
    const { taskId } = await pendingTask();
    const before = await owner.product.findMany({ where: { organizationId: org.organizationId } });

    await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));
    const items = await owner.warehouseTaskItem.findMany({ where: { warehouseTaskId: taskId } });
    for (const item of items) {
      await withTenant(org.organizationId, (tx) =>
        markItemPrepared(tx, org.context, taskId, item.id, true),
      );
    }
    const prepared = await withTenant(org.organizationId, (tx) =>
      markTaskPrepared(tx, org.context, taskId),
    );
    expect(prepared.ok).toBe(true);

    // The boundary. Picked goods are still on the premises and still counted.
    const after = await owner.product.findMany({ where: { organizationId: org.organizationId } });
    for (const product of before) {
      const match = after.find((candidate) => candidate.id === product.id)!;
      expect(match.availableStock).toBe(product.availableStock);
      expect(match.reservedStock).toBe(product.reservedStock);
    }

    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: (await owner.warehouseTask.findUniqueOrThrow({ where: { id: taskId } })).salesOrderId },
    });
    expect(reservations.every((reservation) => reservation.status === 'ACTIVE')).toBe(true);
  });
});

describe('handing goods over', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('decrements both stock figures and consumes the reservation', async () => {
    // Built through `fulfillableOrder` here rather than `handedOver`, because the figures have
    // to be read *between* reserving and handing over. Calling `handedOver` first would create
    // a second order and measure the wrong one.
    const order = await fulfillableOrder(org.organizationId, org.context);
    const items = await owner.salesOrderItem.findMany({ where: { salesOrderId: order.orderId } });
    const sku = items[0]!.skuSnapshot;
    const quantity = items[0]!.reservedQuantity;

    const before = await stockOf(org.organizationId, sku);

    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) throw new Error(created.error.message);
    const taskId = created.value.id;

    await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));
    const taskItems = await owner.warehouseTaskItem.findMany({
      where: { warehouseTaskId: taskId },
    });
    for (const item of taskItems) {
      await withTenant(org.organizationId, (tx) =>
        markItemPrepared(tx, org.context, taskId, item.id, true),
      );
    }
    await withTenant(org.organizationId, (tx) => markTaskPrepared(tx, org.context, taskId));
    const completed = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, taskId),
    );
    expect(completed.ok).toBe(true);

    const after = await stockOf(org.organizationId, sku);
    // The worked example: available falls by exactly what shipped, reserved falls with it, and
    // free stock is unchanged because those units were never promisable to anyone else.
    expect(after.availableStock).toBe(before.availableStock - quantity);
    expect(after.reservedStock).toBe(before.reservedStock - quantity);
    expect(after.availableStock - after.reservedStock).toBe(
      before.availableStock - before.reservedStock,
    );

    await assertStockInvariants(org.organizationId);
  });

  it('marks the reservation CONSUMED, not RELEASED', async () => {
    const { order } = await handedOver(org, {});

    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: order.orderId },
    });
    expect(reservations.length).toBeGreaterThan(0);
    // RELEASED would mean the stock went back on the shelf. It did not.
    expect(reservations.every((reservation) => reservation.status === 'CONSUMED')).toBe(true);
    expect(reservations.every((reservation) => reservation.releasedAt !== null)).toBe(true);
  });

  it('will not let a consumed reservation be rewritten or deleted', async () => {
    const { order } = await handedOver(org, {});
    const reservation = await owner.stockReservation.findFirstOrThrow({
      where: { salesOrderId: order.orderId },
    });

    // The trigger, not the application. A consumed reservation is the only record that specific
    // goods left against a specific order.
    await expect(
      owner.stockReservation.update({ where: { id: reservation.id }, data: { quantity: 1 } }),
    ).rejects.toThrow();
    await expect(
      owner.stockReservation.update({ where: { id: reservation.id }, data: { status: 'ACTIVE' } }),
    ).rejects.toThrow();
    await expect(
      owner.stockReservation.delete({ where: { id: reservation.id } }),
    ).rejects.toThrow();
  });

  it('records the consumption with figures before and after', async () => {
    const { order } = await handedOver(org, {});

    const event = await owner.auditEvent.findFirst({
      where: { organizationId: org.organizationId, action: 'stock.consumed_by_fulfillment' },
    });
    expect(event).not.toBeNull();

    const oldState = event!.oldState as Record<string, unknown>;
    const newState = event!.newState as Record<string, unknown>;
    expect(typeof oldState.availableStock).toBe('number');
    expect(typeof oldState.reservedStock).toBe('number');
    expect(newState.salesOrderId).toBe(order.orderId);
    expect(newState.warehouseTaskId).toBeTruthy();
    expect(Array.isArray(newState.reservationIds)).toBe(true);
    expect((newState.availableStock as number) + (newState.quantity as number)).toBe(
      oldState.availableStock,
    );
  });

  it('is idempotent — a double-clicked handover consumes once', async () => {
    const { order, taskId } = await handedOver(org, {});
    const afterFirst = await owner.product.findMany({ where: { organizationId: org.organizationId } });

    const again = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, taskId),
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.alreadyCompleted).toBe(true);

    const afterSecond = await owner.product.findMany({ where: { organizationId: org.organizationId } });
    for (const product of afterFirst) {
      const match = afterSecond.find((candidate) => candidate.id === product.id)!;
      expect(match.availableStock).toBe(product.availableStock);
      expect(match.reservedStock).toBe(product.reservedStock);
    }
    void order;
  });

  it('refuses when the reservation no longer matches what must be handed over', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;
    const taskId = created.value.id;

    await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));
    const items = await owner.warehouseTaskItem.findMany({ where: { warehouseTaskId: taskId } });
    for (const item of items) {
      await withTenant(org.organizationId, (tx) =>
        markItemPrepared(tx, org.context, taskId, item.id, true),
      );
    }
    await withTenant(org.organizationId, (tx) => markTaskPrepared(tx, org.context, taskId));

    // Corrupt the reservation behind the module's back — the §14 scenario, where the yard and
    // the system disagree.
    const reservation = await owner.stockReservation.findFirstOrThrow({
      where: { salesOrderId: order.orderId, status: 'ACTIVE' },
    });
    const shortfall = 2;
    await owner.stockReservation.update({
      where: { id: reservation.id },
      data: { quantity: reservation.quantity - shortfall },
    });
    await owner.product.update({
      where: { id: reservation.productId },
      data: { reservedStock: { decrement: shortfall } },
    });

    const before = await owner.product.findUniqueOrThrow({ where: { id: reservation.productId } });

    const completed = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, taskId),
    );
    expect(completed.ok).toBe(false);
    if (!completed.ok) {
      expect(completed.error.code).toBe('CONFLICT');
      expect(completed.error.requiresHumanReview).toBe(true);
      // Two numbers and a product, not "something went wrong".
      expect(completed.error.message).toMatch(new RegExp(String(reservation.quantity)));
    }

    // Nothing was repaired and nothing was shipped. A mismatch during fulfilment is an
    // invariant violation, and a shipping operation that adjusted stock to make itself succeed
    // would be the worst possible response.
    const after = await owner.product.findUniqueOrThrow({ where: { id: reservation.productId } });
    expect(after.availableStock).toBe(before.availableStock);
    expect(after.reservedStock).toBe(before.reservedStock);

    const task = await owner.warehouseTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('PREPARED');

    const refusal = await owner.auditEvent.findFirst({
      where: { action: 'warehouse_task.completion_refused_reservation_mismatch' },
    });
    expect(refusal).not.toBeNull();
  });

  it('refuses to hand over a task that was never picked', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;

    const completed = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, created.value.id),
    );
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.error.code).toBe('INVALID_STATE_TRANSITION');
    await assertStockInvariants(org.organizationId);
  });

  it('rolls the whole handover back when the transaction fails', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;
    const taskId = created.value.id;

    await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));
    const items = await owner.warehouseTaskItem.findMany({ where: { warehouseTaskId: taskId } });
    for (const item of items) {
      await withTenant(org.organizationId, (tx) =>
        markItemPrepared(tx, org.context, taskId, item.id, true),
      );
    }
    await withTenant(org.organizationId, (tx) => markTaskPrepared(tx, org.context, taskId));

    const before = await owner.product.findMany({ where: { organizationId: org.organizationId } });

    await expect(
      withTenant(org.organizationId, async (tx) => {
        const result = await completeWarehouseTask(tx, org.context, taskId);
        expect(result.ok).toBe(true);
        throw new Error('something later in the request failed');
      }),
    ).rejects.toThrow('something later in the request failed');

    // Stock, reservations, task state and the audit trail unwind together, or the log would
    // claim goods left that are still on the shelf.
    const after = await owner.product.findMany({ where: { organizationId: org.organizationId } });
    for (const product of before) {
      const match = after.find((candidate) => candidate.id === product.id)!;
      expect(match.availableStock).toBe(product.availableStock);
      expect(match.reservedStock).toBe(product.reservedStock);
    }
    const task = await owner.warehouseTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe('PREPARED');
    expect(await owner.auditEvent.count({ where: { action: 'stock.consumed_by_fulfillment' } })).toBe(0);
  });
});

describe('the collection path', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('creates no delivery for an order the customer collects', async () => {
    const { order, completion } = await handedOver(org, { deliveryRequired: false });

    expect(completion.deliveryId).toBeNull();
    expect(await owner.delivery.count()).toBe(0);

    // Not finished yet: the goods are on the counter, nobody has taken them.
    const beforePickup = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(beforePickup.status).toBe('OPEN');

    const pickup = await withTenant(org.organizationId, (tx) =>
      recordPickup(tx, org.context, order.orderId, 'Collected by the site foreman'),
    );
    expect(pickup.ok).toBe(true);
    if (pickup.ok) expect(pickup.value.orderCompleted).toBe(true);

    const after = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.status).toBe('COMPLETED');
    expect(after.pickedUpAt).not.toBeNull();
    expect(after.completedAt).not.toBeNull();
    expect(await owner.delivery.count()).toBe(0);
  });

  it('refuses a collection before the warehouse has handed over', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      deliveryRequired: false,
    });

    const pickup = await withTenant(org.organizationId, (tx) =>
      recordPickup(tx, org.context, order.orderId, null),
    );
    expect(pickup.ok).toBe(false);
    if (!pickup.ok) expect(pickup.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses a collection on an order marked for delivery', async () => {
    const { order } = await handedOver(org, { deliveryRequired: true });

    const pickup = await withTenant(org.organizationId, (tx) =>
      recordPickup(tx, org.context, order.orderId, null),
    );
    expect(pickup.ok).toBe(false);
    if (!pickup.ok) expect(pickup.error.message).toMatch(/marked for delivery/);
  });

  it('is idempotent', async () => {
    const { order } = await handedOver(org, { deliveryRequired: false });

    const first = await withTenant(org.organizationId, (tx) =>
      recordPickup(tx, org.context, order.orderId, null),
    );
    const second = await withTenant(org.organizationId, (tx) =>
      recordPickup(tx, org.context, order.orderId, null),
    );
    expect(first.ok && second.ok).toBe(true);
    if (second.ok) expect(second.value.alreadyRecorded).toBe(true);
  });
});

describe('delivery', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('is created by the warehouse handover, with snapshotted customer details', async () => {
    const { order, completion } = await handedOver(org, { deliveryRequired: true });

    expect(completion.deliveryId).not.toBeNull();
    expect(completion.deliveryNumber).toMatch(/^DL-\d{6}$/);

    const delivery = await owner.delivery.findUniqueOrThrow({
      where: { id: completion.deliveryId! },
    });
    expect(delivery.status).toBe('PENDING');
    expect(delivery.customerNameSnapshot).toBeTruthy();
    expect(delivery.destinationTextSnapshot).toBeTruthy();

    // Editing the customer afterwards must not rewrite delivery history.
    await owner.customer.update({
      where: { id: order.customerId },
      data: { companyName: 'Renamed Later PLC', phone: '+251900000000' },
    });
    const stillTheSame = await owner.delivery.findUniqueOrThrow({
      where: { id: completion.deliveryId! },
    });
    expect(stillTheSame.customerNameSnapshot).toBe(delivery.customerNameSnapshot);
    expect(stillTheSame.customerNameSnapshot).not.toBe('Renamed Later PLC');
    expect(stillTheSame.customerPhoneSnapshot).toBe(delivery.customerPhoneSnapshot);
  });

  it('does not complete the order until the goods arrive', async () => {
    const { order, completion } = await handedOver(org, { deliveryRequired: true });
    const deliveryId = completion.deliveryId!;

    expect(completion.orderCompleted).toBe(false);
    let row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('OPEN');

    await withTenant(org.organizationId, (tx) =>
      assignDelivery(tx, org.context, deliveryId, {
        driverName: 'Getachew Alemu',
        driverPhone: '+251911223344',
        vehicleReference: 'AA-3-12345',
      }),
    );

    const dispatched = await withTenant(org.organizationId, (tx) =>
      dispatchDelivery(tx, org.context, deliveryId),
    );
    expect(dispatched.ok).toBe(true);

    row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('OPEN');

    const delivered = await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, deliveryId, 'Left with the site foreman'),
    );
    expect(delivered.ok).toBe(true);
    if (delivered.ok) expect(delivered.value.orderCompleted).toBe(true);

    row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.completedAt).not.toBeNull();
  });

  it('refuses to dispatch before the warehouse has handed over', async () => {
    // Reached by hand, because the module only creates a delivery at handover — which is the
    // structural version of this guarantee. The check exists for the case where a delivery is
    // created some other way in a later phase.
    const order = await fulfillableOrder(org.organizationId, org.context, {
      deliveryRequired: true,
    });
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;

    const delivery = await owner.delivery.create({
      data: {
        organizationId: org.organizationId,
        deliveryNumber: 'DL-900001',
        salesOrderId: order.orderId,
        warehouseTaskId: created.value.id,
        status: 'PENDING',
        customerNameSnapshot: 'ABC Construction PLC',
        destinationTextSnapshot: 'Bole, Addis Ababa',
      },
    });

    const dispatched = await withTenant(org.organizationId, (tx) =>
      dispatchDelivery(tx, org.context, delivery.id),
    );
    expect(dispatched.ok).toBe(false);
    if (!dispatched.ok) expect(dispatched.error.code).toBe('CONFLICT');
  });

  it('records a failure without putting anything back on the shelf', async () => {
    const { order, completion } = await handedOver(org, { deliveryRequired: true });
    const deliveryId = completion.deliveryId!;

    await withTenant(org.organizationId, (tx) => dispatchDelivery(tx, org.context, deliveryId));

    const stockBefore = await owner.product.findMany({
      where: { organizationId: org.organizationId },
    });

    const failed = await withTenant(org.organizationId, (tx) =>
      failDelivery(tx, org.context, deliveryId, 'CUSTOMER_UNAVAILABLE', 'Nobody at the gate'),
    );
    expect(failed.ok).toBe(true);

    // The goods are somewhere between the yard and the customer. Nothing here invents them
    // back into inventory.
    const stockAfter = await owner.product.findMany({
      where: { organizationId: org.organizationId },
    });
    for (const product of stockBefore) {
      const match = stockAfter.find((candidate) => candidate.id === product.id)!;
      expect(match.availableStock).toBe(product.availableStock);
      expect(match.reservedStock).toBe(product.reservedStock);
    }

    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: order.orderId },
    });
    // And no ACTIVE reservation reappears.
    expect(reservations.every((reservation) => reservation.status === 'CONSUMED')).toBe(true);

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('OPEN');
    expect(row.completedAt).toBeNull();

    const event = await owner.auditEvent.findFirst({ where: { action: 'delivery.failed' } });
    expect((event!.newState as Record<string, unknown>).stockRestored).toBe(false);
  });

  it('cannot be delivered after it failed', async () => {
    const { completion } = await handedOver(org, { deliveryRequired: true });
    const deliveryId = completion.deliveryId!;

    await withTenant(org.organizationId, (tx) => dispatchDelivery(tx, org.context, deliveryId));
    await withTenant(org.organizationId, (tx) =>
      failDelivery(tx, org.context, deliveryId, 'WRONG_ADDRESS', null),
    );

    const delivered = await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, deliveryId, null),
    );
    expect(delivered.ok).toBe(false);
    if (!delivered.ok) expect(delivered.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('cannot be marked delivered before it was dispatched', async () => {
    const { completion } = await handedOver(org, { deliveryRequired: true });

    const delivered = await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, completion.deliveryId!, null),
    );
    expect(delivered.ok).toBe(false);
  });

  it('records what staff said, and does not call it proof', async () => {
    const { completion } = await handedOver(org, { deliveryRequired: true });
    const deliveryId = completion.deliveryId!;

    await withTenant(org.organizationId, (tx) => dispatchDelivery(tx, org.context, deliveryId));
    await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, deliveryId, 'Handed to the storekeeper'),
    );

    const event = await owner.auditEvent.findFirst({ where: { action: 'delivery.completed' } });
    expect((event!.newState as Record<string, unknown>).basis).toBe('marked completed by staff');
  });

  it('shows the queue with snapshots and filters by status', async () => {
    const { completion } = await handedOver(org, { deliveryRequired: true });

    const pending = await withTenant(org.organizationId, (tx) =>
      deliveryQueue(tx, { statuses: ['PENDING'] }),
    );
    expect(pending.map((row) => row.id)).toEqual([completion.deliveryId]);

    await withTenant(org.organizationId, (tx) =>
      dispatchDelivery(tx, org.context, completion.deliveryId!),
    );

    const stillPending = await withTenant(org.organizationId, (tx) =>
      deliveryQueue(tx, { statuses: ['PENDING'] }),
    );
    expect(stillPending).toHaveLength(0);

    const dispatched = await withTenant(org.organizationId, (tx) =>
      deliveryQueue(tx, { statuses: ['DISPATCHED'] }),
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.dispatchedAt).not.toBeNull();
  });
});

describe('operational completion and money', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('completes a delivered credit order and leaves the whole balance outstanding', async () => {
    // The invariant this phase turns on. Delivering goods on terms finishes the operation and
    // settles nothing.
    const { order, completion } = await handedOver(org, {
      paymentType: 'CREDIT',
      paymentTermsDays: 30,
      deliveryRequired: true,
    });

    await withTenant(org.organizationId, (tx) =>
      dispatchDelivery(tx, org.context, completion.deliveryId!),
    );
    await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, completion.deliveryId!, null),
    );

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('COMPLETED');
    // Untouched by anything on the fulfilment path.
    expect(row.paymentStatus).toBe('NOT_REQUIRED_YET');

    const balance = await withTenant(org.organizationId, (tx) => orderBalance(tx, order.orderId));
    expect(balance.ok).toBe(true);
    if (balance.ok) {
      expect(balance.value.confirmedMinor).toBe(0n);
      expect(balance.value.outstandingMinor).toBe(order.grandTotalMinor);
    }

    const event = await owner.auditEvent.findFirst({ where: { action: 'order.completed' } });
    expect((event!.newState as Record<string, unknown>).paymentSettled).toBe(false);
  });

  it('keeps a completed credit order in receivables once it falls due', async () => {
    const { order, completion } = await handedOver(org, {
      paymentType: 'CREDIT',
      paymentTermsDays: 30,
      deliveryRequired: true,
    });

    await withTenant(org.organizationId, (tx) =>
      dispatchDelivery(tx, org.context, completion.deliveryId!),
    );
    await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, completion.deliveryId!, null),
    );
    await backdateDueDate(order.orderId, 10);

    const rows = await withTenant(org.organizationId, (tx) => receivables(tx));
    const mine = rows.find((row) => row.orderId === order.orderId);

    /*
     * This currently fails, and it is a genuine defect rather than a wrong expectation.
     *
     * `receivables()` filters on `status: 'OPEN'`, which was correct in Phase 5 because an order
     * only left OPEN by being cancelled. Phase 6 introduces a second way out — operational
     * completion — and a delivered credit order is exactly the debt a collections list exists
     * to chase. Removing it from the list because the goods arrived would erase a receivable by
     * delivering it.
     */
    expect(mine, 'a delivered credit order must still be chased').toBeDefined();
    expect(mine!.outstandingMinor).toBe(order.grandTotalMinor);
    expect(mine!.bucket).toBe('OVERDUE');
  });

  it('completes a paid cash order on delivery', async () => {
    const { order, completion } = await handedOver(org, { deliveryRequired: true });

    await withTenant(org.organizationId, (tx) =>
      dispatchDelivery(tx, org.context, completion.deliveryId!),
    );
    await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, completion.deliveryId!, null),
    );

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.paymentStatus).toBe('PAID');
  });

  it('does not put a settled cash order in receivables', async () => {
    const { order, completion } = await handedOver(org, { deliveryRequired: true });
    await withTenant(org.organizationId, (tx) =>
      dispatchDelivery(tx, org.context, completion.deliveryId!),
    );
    await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, completion.deliveryId!, null),
    );

    const rows = await withTenant(org.organizationId, (tx) => receivables(tx));
    expect(rows.find((row) => row.orderId === order.orderId)).toBeUndefined();
  });
});

describe('cancellation once fulfilment has begun', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('blocks cancelling an order the warehouse has started', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;
    await withTenant(org.organizationId, (tx) =>
      startWarehouseTask(tx, org.context, created.value.id),
    );

    const cancelled = await withTenant(org.organizationId, (tx) =>
      cancelOrder(tx, org.context, order.orderId, 'customer changed their mind'),
    );
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.error.code).toBe('CONFLICT');
      expect(cancelled.error.message).toMatch(/Cancel that task first/);
    }

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('OPEN');
    await assertStockInvariants(org.organizationId);
  });

  it('allows cancelling once the warehouse task itself is cancelled', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;
    await withTenant(org.organizationId, (tx) =>
      startWarehouseTask(tx, org.context, created.value.id),
    );
    await withTenant(org.organizationId, (tx) =>
      cancelWarehouseTask(tx, org.context, created.value.id, 'order pulled'),
    );

    const cancelled = await withTenant(org.organizationId, (tx) =>
      cancelOrder(tx, org.context, order.orderId, 'customer changed their mind'),
    );
    expect(cancelled.ok).toBe(true);

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('CANCELLED');
    await assertStockInvariants(org.organizationId);
  });

  it('blocks cancelling once goods have left, permanently', async () => {
    const { order } = await handedOver(org, { paymentType: 'CREDIT', deliveryRequired: true });

    const cancelled = await withTenant(org.organizationId, (tx) =>
      cancelOrder(tx, org.context, order.orderId, 'customer changed their mind'),
    );
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.error.message).toMatch(/already left the warehouse/);
  });

  it('cannot cancel a task after the goods have gone', async () => {
    const { taskId } = await handedOver(org, { paymentType: 'CREDIT' });

    const cancelled = await withTenant(org.organizationId, (tx) =>
      cancelWarehouseTask(tx, org.context, taskId, 'mistake'),
    );
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('leaves reservations alone when a task is cancelled', async () => {
    // The order still exists and still owns its stock. Cancelling the picking job is not
    // cancelling the commitment.
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;

    await withTenant(org.organizationId, (tx) =>
      cancelWarehouseTask(tx, org.context, created.value.id, 'wrong bay'),
    );

    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: order.orderId },
    });
    expect(reservations.every((reservation) => reservation.status === 'ACTIVE')).toBe(true);
    await assertStockInvariants(org.organizationId);
  });

  it('cannot hand over against an order cancelled meanwhile', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context, {
      paymentType: 'CREDIT',
    });
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;
    const taskId = created.value.id;

    await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));
    const items = await owner.warehouseTaskItem.findMany({ where: { warehouseTaskId: taskId } });
    for (const item of items) {
      await withTenant(org.organizationId, (tx) =>
        markItemPrepared(tx, org.context, taskId, item.id, true),
      );
    }
    await withTenant(org.organizationId, (tx) => markTaskPrepared(tx, org.context, taskId));

    // Forced through, because the ordinary path is now blocked by the task being PREPARED.
    await owner.salesOrder.update({
      where: { id: order.orderId },
      data: { status: 'CANCELLED', fulfillmentStatus: 'CANCELLED' },
    });

    const completed = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, taskId),
    );
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.error.code).toBe('CONFLICT');
  });
});

describe('concurrency', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  async function preparedTask(options: Parameters<typeof fulfillableOrder>[2] = {}) {
    const order = await fulfillableOrder(org.organizationId, org.context, options);
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) throw new Error(created.error.message);
    const taskId = created.value.id;

    await withTenant(org.organizationId, (tx) => startWarehouseTask(tx, org.context, taskId));
    const items = await owner.warehouseTaskItem.findMany({ where: { warehouseTaskId: taskId } });
    for (const item of items) {
      await withTenant(org.organizationId, (tx) =>
        markItemPrepared(tx, org.context, taskId, item.id, true),
      );
    }
    await withTenant(org.organizationId, (tx) => markTaskPrepared(tx, org.context, taskId));

    return { order, taskId };
  }

  it('A — two handovers of the same task consume stock exactly once', async () => {
    const { order, taskId } = await preparedTask();
    const items = await owner.salesOrderItem.findMany({ where: { salesOrderId: order.orderId } });
    const sku = items[0]!.skuSnapshot;
    const quantity = items[0]!.reservedQuantity;
    const before = await stockOf(org.organizationId, sku);

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) => completeWarehouseTask(tx, org.context, taskId)),
      withTenant(org.organizationId, (tx) => completeWarehouseTask(tx, org.context, taskId)),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    // One did the work; the other found it done.
    const didWork = results.filter((result) => result.ok && !result.value.alreadyCompleted);
    expect(didWork).toHaveLength(1);

    const after = await stockOf(org.organizationId, sku);
    expect(after.availableStock).toBe(before.availableStock - quantity);
    expect(after.reservedStock).toBe(before.reservedStock - quantity);

    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: order.orderId },
    });
    expect(reservations.every((reservation) => reservation.status === 'CONSUMED')).toBe(true);
    expect(
      await owner.auditEvent.count({ where: { action: 'stock.consumed_by_fulfillment' } }),
    ).toBe(items.length);

    await assertStockInvariants(org.organizationId);
  });

  it('B — a handover racing a cancellation leaves one coherent outcome', async () => {
    const { order, taskId } = await preparedTask({ paymentType: 'CREDIT' });

    const [completed, cancelled] = await Promise.all([
      withTenant(org.organizationId, (tx) => completeWarehouseTask(tx, org.context, taskId)),
      withTenant(org.organizationId, (tx) =>
        cancelOrder(tx, org.context, order.orderId, 'customer withdrew'),
      ),
    ]);

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: order.orderId },
    });

    // Never all three at once: stock consumed, reservation released, order cancelled.
    if (row.status === 'CANCELLED') {
      expect(completed!.ok).toBe(false);
      expect(reservations.every((reservation) => reservation.status === 'RELEASED')).toBe(true);
      expect(
        await owner.auditEvent.count({ where: { action: 'stock.consumed_by_fulfillment' } }),
      ).toBe(0);
    } else {
      expect(cancelled!.ok).toBe(false);
      expect(reservations.every((reservation) => reservation.status === 'CONSUMED')).toBe(true);
      const task = await owner.warehouseTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.status).toBe('COMPLETED');
    }

    await assertStockInvariants(org.organizationId);
  });

  it('C — two orders on the same product decrement it by the exact combined amount', async () => {
    const first = await preparedTask({ message: '20 bags OPC cement' });
    const second = await preparedTask({ message: '15 bags OPC cement' });

    const sku = 'CEM-OPC-50';
    const before = await stockOf(org.organizationId, sku);

    const firstItems = await owner.warehouseTaskItem.findMany({
      where: { warehouseTaskId: first.taskId },
    });
    const secondItems = await owner.warehouseTaskItem.findMany({
      where: { warehouseTaskId: second.taskId },
    });
    const total =
      firstItems.reduce((sum, item) => sum + item.quantityRequired, 0) +
      secondItems.reduce((sum, item) => sum + item.quantityRequired, 0);

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) =>
        completeWarehouseTask(tx, org.context, first.taskId),
      ),
      withTenant(org.organizationId, (tx) =>
        completeWarehouseTask(tx, org.context, second.taskId),
      ),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    const after = await stockOf(org.organizationId, sku);
    expect(after.availableStock).toBe(before.availableStock - total);
    expect(after.reservedStock).toBe(before.reservedStock - total);

    await assertStockInvariants(org.organizationId);
  });

  it('D — a double-clicked dispatch produces one transition and one audit event', async () => {
    const { completion } = await handedOver(org, { deliveryRequired: true });
    const deliveryId = completion.deliveryId!;

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) => dispatchDelivery(tx, org.context, deliveryId)),
      withTenant(org.organizationId, (tx) => dispatchDelivery(tx, org.context, deliveryId)),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    const fresh = results.filter((result) => result.ok && !result.value.alreadyDispatched);
    expect(fresh).toHaveLength(1);
    expect(await owner.auditEvent.count({ where: { action: 'delivery.dispatched' } })).toBe(1);
  });

  it('E — a double-clicked completion produces one set of side effects', async () => {
    const { order, completion } = await handedOver(org, { deliveryRequired: true });
    const deliveryId = completion.deliveryId!;
    await withTenant(org.organizationId, (tx) => dispatchDelivery(tx, org.context, deliveryId));

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) => completeDelivery(tx, org.context, deliveryId, null)),
      withTenant(org.organizationId, (tx) => completeDelivery(tx, org.context, deliveryId, null)),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    expect(await owner.auditEvent.count({ where: { action: 'delivery.completed' } })).toBe(1);
    expect(await owner.auditEvent.count({ where: { action: 'order.completed' } })).toBe(1);

    const row = await owner.salesOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('COMPLETED');
  });

  it('F — two organizations fulfilling at once do not touch each other', async () => {
    const other = await seedOrg('Bole Trading', 'OWNER_ADMIN');

    const mine = await preparedTask({ paymentType: 'CREDIT' });
    const theirsOrder = await fulfillableOrder(other.organizationId, other.context, {
      paymentType: 'CREDIT',
    });
    const theirsTask = await withTenant(other.organizationId, (tx) =>
      createWarehouseTask(tx, other.context, theirsOrder.orderId),
    );
    if (!theirsTask.ok) return;
    await withTenant(other.organizationId, (tx) =>
      startWarehouseTask(tx, other.context, theirsTask.value.id),
    );
    const theirsItems = await owner.warehouseTaskItem.findMany({
      where: { warehouseTaskId: theirsTask.value.id },
    });
    for (const item of theirsItems) {
      await withTenant(other.organizationId, (tx) =>
        markItemPrepared(tx, other.context, theirsTask.value.id, item.id, true),
      );
    }
    await withTenant(other.organizationId, (tx) =>
      markTaskPrepared(tx, other.context, theirsTask.value.id),
    );

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) => completeWarehouseTask(tx, org.context, mine.taskId)),
      withTenant(other.organizationId, (tx) =>
        completeWarehouseTask(tx, other.context, theirsTask.value.id),
      ),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    await assertStockInvariants(org.organizationId);
    await assertStockInvariants(other.organizationId);
  });
});

describe('tenant isolation', () => {
  let orgA: Awaited<ReturnType<typeof seedOrg>>;
  let orgB: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    orgA = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    orgB = await seedOrg('Bole Trading', 'OWNER_ADMIN');
  });

  async function theirTask() {
    const order = await fulfillableOrder(orgB.organizationId, orgB.context, {
      paymentType: 'CREDIT',
      deliveryRequired: true,
    });
    const created = await withTenant(orgB.organizationId, (tx) =>
      createWarehouseTask(tx, orgB.context, order.orderId),
    );
    if (!created.ok) throw new Error(created.error.message);
    return { order, taskId: created.value.id };
  }

  it('does not let one organization read another’s warehouse task', async () => {
    const theirs = await theirTask();

    const read = await withTenant(orgA.organizationId, (tx) =>
      getWarehouseTask(tx, theirs.taskId),
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('NOT_FOUND');

    // Not vacuous: the owner can still read it.
    const byOwner = await withTenant(orgB.organizationId, (tx) =>
      getWarehouseTask(tx, theirs.taskId),
    );
    expect(byOwner.ok).toBe(true);
  });

  it('does not let one organization drive another’s task', async () => {
    const theirs = await theirTask();

    for (const attempt of [
      () =>
        withTenant(orgA.organizationId, (tx) =>
          startWarehouseTask(tx, orgA.context, theirs.taskId),
        ),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          markTaskPrepared(tx, orgA.context, theirs.taskId),
        ),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          completeWarehouseTask(tx, orgA.context, theirs.taskId),
        ),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          cancelWarehouseTask(tx, orgA.context, theirs.taskId, 'not mine'),
        ),
    ]) {
      const result = await attempt();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    }

    const task = await owner.warehouseTask.findUniqueOrThrow({ where: { id: theirs.taskId } });
    expect(task.status).toBe('PENDING');
  });

  it('cannot raise a task against another organization’s order', async () => {
    const theirs = await theirTask();

    const created = await withTenant(orgA.organizationId, (tx) =>
      createWarehouseTask(tx, orgA.context, theirs.order.orderId),
    );
    expect(created.ok).toBe(false);
    expect(
      await owner.warehouseTask.count({ where: { organizationId: orgA.organizationId } }),
    ).toBe(0);
  });

  it('cannot consume another organization’s stock or reservations', async () => {
    const order = await fulfillableOrder(orgB.organizationId, orgB.context, {
      paymentType: 'CREDIT',
    });
    const created = await withTenant(orgB.organizationId, (tx) =>
      createWarehouseTask(tx, orgB.context, order.orderId),
    );
    if (!created.ok) return;
    await withTenant(orgB.organizationId, (tx) =>
      startWarehouseTask(tx, orgB.context, created.value.id),
    );
    const items = await owner.warehouseTaskItem.findMany({
      where: { warehouseTaskId: created.value.id },
    });
    for (const item of items) {
      await withTenant(orgB.organizationId, (tx) =>
        markItemPrepared(tx, orgB.context, created.value.id, item.id, true),
      );
    }
    await withTenant(orgB.organizationId, (tx) =>
      markTaskPrepared(tx, orgB.context, created.value.id),
    );

    const before = await owner.product.findMany({ where: { organizationId: orgB.organizationId } });

    const stolen = await withTenant(orgA.organizationId, (tx) =>
      completeWarehouseTask(tx, orgA.context, created.value.id),
    );
    expect(stolen.ok).toBe(false);

    const after = await owner.product.findMany({ where: { organizationId: orgB.organizationId } });
    for (const product of before) {
      const match = after.find((candidate) => candidate.id === product.id)!;
      expect(match.availableStock).toBe(product.availableStock);
      expect(match.reservedStock).toBe(product.reservedStock);
    }
  });

  it('does not let one organization touch another’s delivery', async () => {
    const theirs = await theirTask();
    await withTenant(orgB.organizationId, (tx) =>
      startWarehouseTask(tx, orgB.context, theirs.taskId),
    );
    const items = await owner.warehouseTaskItem.findMany({
      where: { warehouseTaskId: theirs.taskId },
    });
    for (const item of items) {
      await withTenant(orgB.organizationId, (tx) =>
        markItemPrepared(tx, orgB.context, theirs.taskId, item.id, true),
      );
    }
    await withTenant(orgB.organizationId, (tx) =>
      markTaskPrepared(tx, orgB.context, theirs.taskId),
    );
    const completed = await withTenant(orgB.organizationId, (tx) =>
      completeWarehouseTask(tx, orgB.context, theirs.taskId),
    );
    if (!completed.ok) return;
    const deliveryId = completed.value.deliveryId!;

    const read = await withTenant(orgA.organizationId, (tx) => getDelivery(tx, deliveryId));
    expect(read.ok).toBe(false);

    for (const attempt of [
      () =>
        withTenant(orgA.organizationId, (tx) =>
          assignDelivery(tx, orgA.context, deliveryId, { driverName: 'Not Mine' }),
        ),
      () => withTenant(orgA.organizationId, (tx) => dispatchDelivery(tx, orgA.context, deliveryId)),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          completeDelivery(tx, orgA.context, deliveryId, null),
        ),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          failDelivery(tx, orgA.context, deliveryId, 'OTHER', null),
        ),
    ]) {
      const result = await attempt();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    }

    const delivery = await owner.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.status).toBe('PENDING');
    expect(delivery.assignedDriverName).toBeNull();
  });

  it('keeps the queues inside one organization', async () => {
    await theirTask();
    const mineOrder = await fulfillableOrder(orgA.organizationId, orgA.context, {
      paymentType: 'CREDIT',
    });
    const mine = await withTenant(orgA.organizationId, (tx) =>
      createWarehouseTask(tx, orgA.context, mineOrder.orderId),
    );
    if (!mine.ok) return;

    const queue = await withTenant(orgA.organizationId, (tx) => warehouseQueue(tx));
    expect(queue.map((row) => row.id)).toEqual([mine.value.id]);

    const deliveries = await withTenant(orgA.organizationId, (tx) => deliveryQueue(tx));
    expect(deliveries).toHaveLength(0);
  });

  it('treats a malformed or unknown id as not found rather than as an error page', async () => {
    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      expect((await withTenant(orgA.organizationId, (tx) => getWarehouseTask(tx, id))).ok).toBe(
        false,
      );
      expect((await withTenant(orgA.organizationId, (tx) => getDelivery(tx, id))).ok).toBe(false);
      expect(
        (await withTenant(orgA.organizationId, (tx) => startWarehouseTask(tx, orgA.context, id)))
          .ok,
      ).toBe(false);
      expect(
        (await withTenant(orgA.organizationId, (tx) => dispatchDelivery(tx, orgA.context, id))).ok,
      ).toBe(false);
      expect(
        (await withTenant(orgA.organizationId, (tx) => recordPickup(tx, orgA.context, id, null)))
          .ok,
      ).toBe(false);
    }
  });
});

describe('the warehouse view', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    restoreFileStore();
    useMemoryFileStore();
  });

  it('shows what to pick and no financial detail', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;

    const view = await withTenant(org.organizationId, (tx) =>
      getWarehouseTask(tx, created.value.id),
    );
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    expect(view.value.items.length).toBeGreaterThan(0);
    for (const item of view.value.items) {
      expect(item.sku).toBeTruthy();
      expect(item.unit).toBeTruthy();
      expect(item.quantityRequired).toBeGreaterThan(0);
      expect(item.activeReservedQuantity).toBe(item.quantityRequired);
    }
    expect(view.value.reservationsAgree).toBe(true);

    // A picker needs a quantity, not a price. Nothing on this view carries money at all.
    const serialised = JSON.stringify(view.value);
    expect(serialised).not.toMatch(/Minor|price|discount|grandTotal/i);
  });

  it('reports the queue with a payment indicator rather than an amount', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);
    await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );

    const queue = await withTenant(org.organizationId, (tx) => warehouseQueue(tx));
    expect(queue).toHaveLength(1);
    expect(queue[0]!.paymentCleared).toBe(true);
    expect(queue[0]!.totalUnits).toBeGreaterThan(0);
    expect(JSON.stringify(queue[0])).not.toMatch(/Minor/);
  });

  it('surfaces a reservation mismatch before anyone tries to complete', async () => {
    const order = await fulfillableOrder(org.organizationId, org.context);
    const created = await withTenant(org.organizationId, (tx) =>
      createWarehouseTask(tx, org.context, order.orderId),
    );
    if (!created.ok) return;

    const reservation = await owner.stockReservation.findFirstOrThrow({
      where: { salesOrderId: order.orderId, status: 'ACTIVE' },
    });
    await owner.stockReservation.update({
      where: { id: reservation.id },
      data: { quantity: reservation.quantity - 3 },
    });
    await owner.product.update({
      where: { id: reservation.productId },
      data: { reservedStock: { decrement: 3 } },
    });

    const view = await withTenant(org.organizationId, (tx) =>
      getWarehouseTask(tx, created.value.id),
    );
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.value.reservationsAgree).toBe(false);
  });

  it('reports the fulfilment position for an order screen', async () => {
    const { order, completion } = await handedOver(org, { deliveryRequired: true });

    const position = await withTenant(org.organizationId, (tx) =>
      fulfillmentForOrder(tx, order.orderId),
    );
    expect(position.task?.status).toBe('COMPLETED');
    expect(position.delivery?.id).toBe(completion.deliveryId);
    expect(position.delivery?.status).toBe('PENDING');
  });
});
