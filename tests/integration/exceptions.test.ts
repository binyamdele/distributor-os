import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { adjustStock } from '@/modules/catalog';
import {
  completeDelivery,
  completeWarehouseTask,
  createWarehouseTask,
  dispatchDelivery,
  failDelivery,
  markItemPrepared,
  markTaskPrepared,
  startWarehouseTask,
} from '@/modules/fulfillment';
import { orderBalance } from '@/modules/payments';
import {
  blockingDiscrepancies,
  cancelDiscrepancy,
  completeReturn,
  createDeliveryRetry,
  createReturn,
  deliveryAttempts,
  getDiscrepancy,
  getReturn,
  inspectReturn,
  inventoryExceptions,
  movementsForProduct,
  receiveReturn,
  reconcileDiscrepancy,
  reconcileLedger,
  reportDiscrepancy,
  resolveDeliveryLoss,
  resolveReservationShortfall,
  returnQueue,
  reviewDiscrepancy,
  unresolvedFailures,
} from '@/modules/inventory';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';
import { useMemoryFileStore } from '../support/payment-fixtures';
import { assertStockInvariants, fulfillableOrder, stockOf } from '../support/fulfillment-fixtures';
import { seedCatalogue } from '../support/catalogue';

/**
 * Phase 7 against a real PostgreSQL.
 *
 * The unit tests pin the arithmetic. What can only be proved here is that a physical count
 * changes nothing until somebody authorises it, that an impossible stock state cannot be
 * persisted, that a retry moves no inventory, that a return puts back exactly the sellable
 * portion once, and that none of it touches a confirmed payment.
 */

type Org = Awaited<ReturnType<typeof seedOrg>>;

async function preparedTask(org: Org, options: Parameters<typeof fulfillableOrder>[2] = {}) {
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

  return { order, taskId, productId: items[0]!.productId!, quantity: items[0]!.quantityRequired };
}

/** Takes an order all the way to a failed delivery, with the goods gone. */
async function failedDelivery(org: Org, options: Parameters<typeof fulfillableOrder>[2] = {}) {
  const prepared = await preparedTask(org, { ...options, deliveryRequired: true });

  const completed = await withTenant(org.organizationId, (tx) =>
    completeWarehouseTask(tx, org.context, prepared.taskId),
  );
  if (!completed.ok) throw new Error(completed.error.message);
  const deliveryId = completed.value.deliveryId!;

  await withTenant(org.organizationId, (tx) => dispatchDelivery(tx, org.context, deliveryId));
  const failed = await withTenant(org.organizationId, (tx) =>
    failDelivery(tx, org.context, deliveryId, 'CUSTOMER_UNAVAILABLE', 'Nobody at the gate'),
  );
  if (!failed.ok) throw new Error(failed.error.message);

  return { ...prepared, deliveryId };
}

describe('reporting a physical count', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('records the disagreement and changes no stock', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });
    const before = { available: product.availableStock, reserved: product.reservedStock };

    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: product.id,
        physicalCount: before.available - 40,
        note: 'Counted bay 3 twice.',
      }),
    );
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.value.discrepancyNumber).toMatch(/^IR-\d{6}$/);
    expect(reported.value.variance).toBe(-40);
    expect(reported.value.type).toBe('PHYSICAL_SHORTAGE');

    // The whole point of separating reporting from resolving.
    const after = await owner.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.availableStock).toBe(before.available);
    expect(after.reservedStock).toBe(before.reserved);
    expect(await owner.inventoryMovement.count({ where: { productId: product.id } })).toBe(0);
  });

  it('snapshots what the system claimed at the moment somebody disagreed', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'CEM-OPC-50' },
    });

    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, { productId: product.id, physicalCount: 10 }),
    );
    if (!reported.ok) return;

    // Move stock afterwards. The snapshot must not follow it — it is the record of the claim
    // being argued with, and re-deriving it would erase the disagreement.
    await withTenant(org.organizationId, (tx) =>
      adjustStock(tx, org.context, product.id, { delta: -5, reason: 'unrelated correction' }),
    );

    const row = await owner.inventoryDiscrepancy.findUniqueOrThrow({
      where: { id: reported.value.id },
    });
    expect(row.systemOnHandQuantity).toBe(product.availableStock);
    expect(row.physicalCountQuantity).toBe(10);
    expect(row.varianceQuantity).toBe(10 - product.availableStock);
  });

  it('links the discrepancy to the task and order it was found on', async () => {
    const prepared = await preparedTask(org);

    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: prepared.productId,
        physicalCount: 5,
        warehouseTaskId: prepared.taskId,
      }),
    );
    if (!reported.ok) return;

    const row = await owner.inventoryDiscrepancy.findUniqueOrThrow({
      where: { id: reported.value.id },
    });
    expect(row.warehouseTaskId).toBe(prepared.taskId);
    expect(row.salesOrderId).toBe(prepared.order.orderId);
    expect(row.expectedTaskQuantity).toBe(prepared.quantity);
  });

  it('records the variance as arithmetic the database will not let drift', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'RB-12' },
    });
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, { productId: product.id, physicalCount: 3 }),
    );
    if (!reported.ok) return;

    await expect(
      owner.inventoryDiscrepancy.update({
        where: { id: reported.value.id },
        data: { varianceQuantity: 999 },
      }),
    ).rejects.toThrow();
  });
});

describe('a discrepancy blocks the handover', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('refuses the handover and names the product and both figures', async () => {
    const prepared = await preparedTask(org);
    const before = await owner.product.findUniqueOrThrow({ where: { id: prepared.productId } });

    await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: prepared.productId,
        physicalCount: before.availableStock - 40,
        warehouseTaskId: prepared.taskId,
      }),
    );

    const completed = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, prepared.taskId),
    );
    expect(completed.ok).toBe(false);
    if (!completed.ok) {
      expect(completed.error.code).toBe('CONFLICT');
      expect(completed.error.requiresHumanReview).toBe(true);
      expect(completed.error.message).toMatch(/^IR-\d{6} is open/);
      expect(completed.error.message).toContain(String(before.availableStock));
      // The details carry enough to move straight into the exception workflow.
      const details = completed.error.details?.discrepancies as { sku: string }[] | undefined;
      expect(details?.[0]?.sku).toBeTruthy();
    }

    // Nothing moved, and the task is still picked and waiting.
    const after = await owner.product.findUniqueOrThrow({ where: { id: prepared.productId } });
    expect(after.availableStock).toBe(before.availableStock);
    const task = await owner.warehouseTask.findUniqueOrThrow({ where: { id: prepared.taskId } });
    expect(task.status).toBe('PREPARED');
    await assertStockInvariants(org.organizationId);
  });

  it('stays blocked while the discrepancy is merely under review', async () => {
    const prepared = await preparedTask(org);
    const before = await owner.product.findUniqueOrThrow({ where: { id: prepared.productId } });

    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: prepared.productId,
        physicalCount: before.availableStock - 5,
        warehouseTaskId: prepared.taskId,
      }),
    );
    if (!reported.ok) return;
    await withTenant(org.organizationId, (tx) =>
      reviewDiscrepancy(tx, org.context, reported.value.id),
    );

    const completed = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, prepared.taskId),
    );
    expect(completed.ok).toBe(false);
  });

  it('lets the handover through once the count is reconciled', async () => {
    const prepared = await preparedTask(org);
    const before = await owner.product.findUniqueOrThrow({ where: { id: prepared.productId } });

    // A shortage that still covers what is committed to this order.
    const counted = before.availableStock - 1;
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: prepared.productId,
        physicalCount: counted,
        warehouseTaskId: prepared.taskId,
      }),
    );
    if (!reported.ok) return;

    const reconciled = await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, reported.value.id, 'recounted with the supervisor'),
    );
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value.delta).toBe(-1);

    const completed = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, prepared.taskId),
    );
    expect(completed.ok).toBe(true);
    await assertStockInvariants(org.organizationId);
  });

  it('lets the handover through once the discrepancy is withdrawn', async () => {
    const prepared = await preparedTask(org);
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: prepared.productId,
        physicalCount: 1,
        warehouseTaskId: prepared.taskId,
      }),
    );
    if (!reported.ok) return;

    await withTenant(org.organizationId, (tx) =>
      cancelDiscrepancy(tx, org.context, reported.value.id, 'counted the wrong bay'),
    );

    const blocking = await withTenant(org.organizationId, (tx) =>
      blockingDiscrepancies(tx, prepared.taskId),
    );
    expect(blocking).toHaveLength(0);

    const completed = await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, prepared.taskId),
    );
    expect(completed.ok).toBe(true);
  });
});

describe('reconciling a count', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('applies the shortage and records a movement that explains it', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    const counted = product.availableStock - 40;

    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, { productId: product.id, physicalCount: counted }),
    );
    if (!reported.ok) return;

    const reconciled = await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, reported.value.id, null),
    );
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.value).toMatchObject({ applied: true, delta: -40, stockAfter: counted });

    const after = await owner.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.availableStock).toBe(counted);

    // "Why did this decrease by 40" is now a row, not a reconstruction.
    const movements = await withTenant(org.organizationId, (tx) =>
      movementsForProduct(tx, product.id),
    );
    expect(movements[0]).toMatchObject({
      movementType: 'DISCREPANCY_RECONCILIATION',
      delta: -40,
      stockAfter: counted,
    });
    expect(movements[0]!.reason).toContain(reported.value.discrepancyNumber);
    expect(movements[0]!.relatedDiscrepancyId).toBe(reported.value.id);
  });

  it('applies an overage', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    const counted = product.availableStock + 10;

    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, { productId: product.id, physicalCount: counted }),
    );
    if (!reported.ok) return;

    const reconciled = await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, reported.value.id, null),
    );
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value.delta).toBe(10);
    expect(
      (await owner.product.findUniqueOrThrow({ where: { id: product.id } })).availableStock,
    ).toBe(counted);
  });

  it('resolves without change when the recount agrees', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    // Reported as a shortage, then the shelf is corrected by other means before review.
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: product.id,
        physicalCount: product.availableStock,
      }),
    );
    if (!reported.ok) return;

    const reconciled = await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, reported.value.id, 'recount agreed'),
    );
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.value.applied).toBe(false);

    const row = await owner.inventoryDiscrepancy.findUniqueOrThrow({
      where: { id: reported.value.id },
    });
    expect(row.status).toBe('RESOLVED');
    expect(row.resolutionType).toBe('COUNT_CONFIRMED_NO_CHANGE');
    expect(await owner.inventoryMovement.count({ where: { productId: product.id } })).toBe(0);
  });

  it('refuses when stock has moved since the count was taken', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: product.id,
        physicalCount: product.availableStock - 10,
      }),
    );
    if (!reported.ok) return;

    await withTenant(org.organizationId, (tx) =>
      adjustStock(tx, org.context, product.id, { delta: -5, reason: 'separate correction' }),
    );

    const reconciled = await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, reported.value.id, null),
    );
    expect(reconciled.ok).toBe(false);
    if (!reconciled.ok) {
      expect(reconciled.error.details?.refusal).toBe('STOCK_MOVED_SINCE_REPORT');
      expect(reconciled.error.message).toMatch(/Count again/);
    }
  });

  it('refuses to resolve twice, at the database as well', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: product.id,
        physicalCount: product.availableStock - 3,
      }),
    );
    if (!reported.ok) return;

    await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, reported.value.id, null),
    );

    const again = await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, reported.value.id, null),
    );
    expect(again.ok).toBe(false);

    // The trigger holds even around the module.
    await expect(
      owner.inventoryDiscrepancy.update({
        where: { id: reported.value.id },
        data: { status: 'OPEN' },
      }),
    ).rejects.toThrow();
  });
});

describe('a count the committed stock cannot support', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  /** An order holding stock, plus a count below what it holds. */
  async function shortfall() {
    const prepared = await preparedTask(org, { paymentType: 'CREDIT' });
    const product = await owner.product.findUniqueOrThrow({ where: { id: prepared.productId } });

    // Count below the committed quantity: fewer on the shelf than this order alone needs.
    const counted = prepared.quantity - 2;
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: prepared.productId,
        physicalCount: counted,
        warehouseTaskId: prepared.taskId,
      }),
    );
    if (!reported.ok) throw new Error(reported.error.message);

    return { prepared, product, counted, discrepancyId: reported.value.id };
  }

  it('refuses to persist an impossible stock state and names the shortfall', async () => {
    const scenario = await shortfall();

    const reconciled = await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, scenario.discrepancyId, null),
    );
    expect(reconciled.ok).toBe(false);
    if (!reconciled.ok) {
      expect(reconciled.error.details?.refusal).toBe('RESERVATION_SHORTFALL');
      expect(reconciled.error.requiresHumanReview).toBe(true);
      expect(reconciled.error.message).toContain('2');
    }

    // Nothing moved, and the shortfall is recorded on the row rather than in a message that
    // disappears when the page closes.
    const after = await owner.product.findUniqueOrThrow({ where: { id: scenario.product.id } });
    expect(after.availableStock).toBe(scenario.product.availableStock);
    const row = await owner.inventoryDiscrepancy.findUniqueOrThrow({
      where: { id: scenario.discrepancyId },
    });
    expect(row.reservationShortfall).toBe(2);
    expect(row.status).toBe('UNDER_REVIEW');
    await assertStockInvariants(org.organizationId);
  });

  it('surfaces the affected orders without ranking them', async () => {
    const scenario = await shortfall();

    const view = await withTenant(org.organizationId, (tx) =>
      getDiscrepancy(tx, scenario.discrepancyId),
    );
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    expect(view.value.affectedOrders.length).toBeGreaterThan(0);
    const mine = view.value.affectedOrders.find(
      (entry) => entry.salesOrderId === scenario.prepared.order.orderId,
    );
    expect(mine).toBeDefined();
    expect(mine!.reservedQuantity).toBe(scenario.prepared.quantity);
    expect(mine!.customerName).toBeTruthy();
    // Sorted by order number — deliberately by nothing meaningful.
    const numbers = view.value.affectedOrders.map((entry) => entry.orderNumber);
    expect([...numbers].sort()).toEqual(numbers);
  });

  it('lets sales reduce a named reservation, then the count applies', async () => {
    const scenario = await shortfall();

    const reservation = await owner.stockReservation.findFirstOrThrow({
      where: { salesOrderId: scenario.prepared.order.orderId, status: 'ACTIVE' },
    });

    const resolved = await withTenant(org.organizationId, (tx) =>
      resolveReservationShortfall(
        tx,
        org.context,
        reservation.id,
        scenario.counted,
        'customer agreed to take what is here',
      ),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.orderUnfulfillable).toBe(true);

    // The accepted order is untouched — that is what the customer agreed to buy.
    const item = await owner.salesOrderItem.findFirstOrThrow({
      where: { salesOrderId: scenario.prepared.order.orderId },
    });
    expect(item.quantity).toBe(scenario.prepared.quantity);
    expect(item.reservedQuantity).toBe(scenario.counted);

    const order = await owner.salesOrder.findUniqueOrThrow({
      where: { id: scenario.prepared.order.orderId },
    });
    expect(order.operationalException).toBe('STOCK_SHORTFALL');
    expect(order.operationalExceptionNote).toContain(String(scenario.prepared.quantity));

    // Now the count can be written.
    const reconciled = await withTenant(org.organizationId, (tx) =>
      reconcileDiscrepancy(tx, org.context, scenario.discrepancyId, null),
    );
    expect(reconciled.ok).toBe(true);
    await assertStockInvariants(org.organizationId);
  });

  it('never creates a backorder, a substitute or a revised quotation', async () => {
    const scenario = await shortfall();
    const reservation = await owner.stockReservation.findFirstOrThrow({
      where: { salesOrderId: scenario.prepared.order.orderId, status: 'ACTIVE' },
    });

    const quotationsBefore = await owner.quotation.count();
    const ordersBefore = await owner.salesOrder.count();
    const itemsBefore = await owner.salesOrderItem.count();

    await withTenant(org.organizationId, (tx) =>
      resolveReservationShortfall(tx, org.context, reservation.id, scenario.counted, 'agreed'),
    );

    expect(await owner.quotation.count()).toBe(quotationsBefore);
    expect(await owner.salesOrder.count()).toBe(ordersBefore);
    expect(await owner.salesOrderItem.count()).toBe(itemsBefore);
  });

  it('refuses a reduction that is not a reduction', async () => {
    const scenario = await shortfall();
    const reservation = await owner.stockReservation.findFirstOrThrow({
      where: { salesOrderId: scenario.prepared.order.orderId, status: 'ACTIVE' },
    });

    for (const quantity of [reservation.quantity, reservation.quantity + 1]) {
      const result = await withTenant(org.organizationId, (tx) =>
        resolveReservationShortfall(tx, org.context, reservation.id, quantity, 'agreed'),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('releases the reservation entirely when reduced to zero', async () => {
    const scenario = await shortfall();
    const reservation = await owner.stockReservation.findFirstOrThrow({
      where: { salesOrderId: scenario.prepared.order.orderId, status: 'ACTIVE' },
    });

    const resolved = await withTenant(org.organizationId, (tx) =>
      resolveReservationShortfall(tx, org.context, reservation.id, 0, 'nothing left for them'),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.released).toBe(true);

    const after = await owner.stockReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.status).toBe('RELEASED');
    await assertStockInvariants(org.organizationId);
  });
});

describe('the inventory movement ledger', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('records a manual correction, a shipment and a restock in one history', async () => {
    const prepared = await preparedTask(org);

    await withTenant(org.organizationId, (tx) =>
      adjustStock(tx, org.context, prepared.productId, {
        delta: 5,
        reason: 'found a pallet behind the door',
      }),
    );
    await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, prepared.taskId),
    );

    const movements = await withTenant(org.organizationId, (tx) =>
      movementsForProduct(tx, prepared.productId),
    );
    const types = movements.map((movement) => movement.movementType);
    expect(types).toContain('MANUAL_ADJUSTMENT');
    expect(types).toContain('FULFILLMENT_CONSUMPTION');

    const consumption = movements.find(
      (movement) => movement.movementType === 'FULFILLMENT_CONSUMPTION',
    )!;
    expect(consumption.delta).toBe(-prepared.quantity);
    expect(consumption.relatedOrderId).toBe(prepared.order.orderId);
  });

  it('reconciles against the product figure from its own baseline', async () => {
    const prepared = await preparedTask(org);
    await withTenant(org.organizationId, (tx) =>
      adjustStock(tx, org.context, prepared.productId, { delta: -7, reason: 'breakage' }),
    );
    await withTenant(org.organizationId, (tx) =>
      completeWarehouseTask(tx, org.context, prepared.taskId),
    );

    const check = await withTenant(org.organizationId, (tx) =>
      reconcileLedger(tx, prepared.productId),
    );
    expect(check).not.toBeNull();
    expect(check!.agrees).toBe(true);
    expect(check!.expected).toBe(check!.actual);
  });

  it('is append-only — history cannot be rewritten or deleted', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    await withTenant(org.organizationId, (tx) =>
      adjustStock(tx, org.context, product.id, { delta: -1, reason: 'breakage' }),
    );
    const movement = await owner.inventoryMovement.findFirstOrThrow({
      where: { productId: product.id },
    });

    // Attempted as the application role, which is what the REVOKE governs.
    await expect(
      withTenant(org.organizationId, (tx) =>
        tx.inventoryMovement.update({ where: { id: movement.id }, data: { delta: 999 } }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(org.organizationId, (tx) =>
        tx.inventoryMovement.delete({ where: { id: movement.id } }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a movement that moves nothing', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    await expect(
      owner.inventoryMovement.create({
        data: {
          organizationId: org.organizationId,
          productId: product.id,
          movementType: 'OTHER',
          delta: 0,
          stockAfter: product.availableStock,
          reason: 'nothing happened',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('resolving a failed delivery by retrying', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('creates a new attempt and touches no stock', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const before = await owner.product.findMany({ where: { organizationId: org.organizationId } });
    const movementsBefore = await owner.inventoryMovement.count();

    const retry = await withTenant(org.organizationId, (tx) =>
      createDeliveryRetry(tx, org.context, scenario.deliveryId),
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.deliveryNumber).toMatch(/^DL-\d{6}$/);
    expect(retry.value.attemptNumber).toBe(2);

    // The invariant §22 demands: no reservation, no consumption, no decrement, nothing.
    const after = await owner.product.findMany({ where: { organizationId: org.organizationId } });
    for (const product of before) {
      const match = after.find((candidate) => candidate.id === product.id)!;
      expect(match.availableStock).toBe(product.availableStock);
      expect(match.reservedStock).toBe(product.reservedStock);
    }
    expect(await owner.inventoryMovement.count()).toBe(movementsBefore);
    expect(
      await owner.stockReservation.count({
        where: { salesOrderId: scenario.order.orderId, status: 'ACTIVE' },
      }),
    ).toBe(0);

    // And no second warehouse task.
    expect(
      await owner.warehouseTask.count({ where: { salesOrderId: scenario.order.orderId } }),
    ).toBe(1);
  });

  it('leaves the failed delivery failed, and records how it was resolved', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    await withTenant(org.organizationId, (tx) =>
      createDeliveryRetry(tx, org.context, scenario.deliveryId),
    );

    const original = await owner.delivery.findUniqueOrThrow({
      where: { id: scenario.deliveryId },
    });
    // Not rewritten backwards. The failure happened.
    expect(original.status).toBe('FAILED');
    expect(original.failedAt).not.toBeNull();
    expect(original.failureResolution).toBe('RETRY_DELIVERY');
  });

  it('keeps the attempt history readable', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const retry = await withTenant(org.organizationId, (tx) =>
      createDeliveryRetry(tx, org.context, scenario.deliveryId),
    );
    if (!retry.ok) return;

    const attempts = await withTenant(org.organizationId, (tx) =>
      deliveryAttempts(tx, scenario.order.orderId),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, status: 'FAILED' });
    expect(attempts[1]).toMatchObject({
      attemptNumber: 2,
      status: 'PENDING',
      retryOfDeliveryId: scenario.deliveryId,
    });
  });

  it('completes the order when the retry succeeds, without consuming stock again', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const stockAfterShipment = await stockOf(org.organizationId, 'CEM-OPC-50');

    const retry = await withTenant(org.organizationId, (tx) =>
      createDeliveryRetry(tx, org.context, scenario.deliveryId),
    );
    if (!retry.ok) return;

    await withTenant(org.organizationId, (tx) => dispatchDelivery(tx, org.context, retry.value.id));
    const delivered = await withTenant(org.organizationId, (tx) =>
      completeDelivery(tx, org.context, retry.value.id, 'second attempt'),
    );
    expect(delivered.ok).toBe(true);
    if (delivered.ok) expect(delivered.value.orderCompleted).toBe(true);

    const order = await owner.salesOrder.findUniqueOrThrow({
      where: { id: scenario.order.orderId },
    });
    expect(order.status).toBe('COMPLETED');
    expect(order.operationalException).toBeNull();

    // Stock is exactly where the original shipment left it.
    expect(await stockOf(org.organizationId, 'CEM-OPC-50')).toEqual(stockAfterShipment);
    expect(
      await owner.inventoryMovement.count({ where: { movementType: 'FULFILLMENT_CONSUMPTION' } }),
    ).toBe(1);
  });

  it('does not complete the order while the failure is unresolved', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });

    const order = await owner.salesOrder.findUniqueOrThrow({
      where: { id: scenario.order.orderId },
    });
    expect(order.status).toBe('OPEN');
    expect(order.completedAt).toBeNull();
  });

  it('refuses to retry once the goods are back on the shelf', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });

    const created = await withTenant(org.organizationId, (tx) =>
      createReturn(tx, org.context, scenario.deliveryId, null),
    );
    if (!created.ok) return;
    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.value.id));
    const items = await owner.returnItem.findMany({ where: { returnId: created.value.id } });
    await withTenant(org.organizationId, (tx) =>
      inspectReturn(
        tx,
        org.context,
        created.value.id,
        items.map((item) => ({
          itemId: item.id,
          received: item.quantityExpected,
          restockable: item.quantityExpected,
          damaged: 0,
        })),
      ),
    );
    await withTenant(org.organizationId, (tx) => completeReturn(tx, org.context, created.value.id));

    const retry = await withTenant(org.organizationId, (tx) =>
      createDeliveryRetry(tx, org.context, scenario.deliveryId),
    );
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.error.details?.refusal).toBe('GOODS_BACK_IN_WAREHOUSE');
      expect(retry.error.message).toMatch(/through the warehouse/);
    }
  });
});

describe('resolving a failed delivery by returning the goods', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  async function returnFor(scenario: Awaited<ReturnType<typeof failedDelivery>>) {
    const created = await withTenant(org.organizationId, (tx) =>
      createReturn(tx, org.context, scenario.deliveryId, 'coming back tomorrow'),
    );
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  }

  it('creates the return from what actually went out', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await returnFor(scenario);

    expect(created.returnNumber).toMatch(/^RT-\d{6}$/);

    const items = await owner.returnItem.findMany({ where: { returnId: created.id } });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.quantityDispatched).toBeGreaterThan(0);
      expect(item.quantityExpected).toBe(item.quantityDispatched);
      expect(item.quantityReceived).toBe(0);
    }

    const order = await owner.salesOrder.findUniqueOrThrow({
      where: { id: scenario.order.orderId },
    });
    expect(order.operationalException).toBe('GOODS_RETURNED');
  });

  it('restocks only the sellable portion, and keeps the rest in history', async () => {
    // The §19 worked example: 80 out, 76 sellable, 4 damaged.
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await returnFor(scenario);
    const before = await stockOf(org.organizationId, 'CEM-OPC-50');

    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.id));

    const items = await owner.returnItem.findMany({ where: { returnId: created.id } });
    const line = items[0]!;
    const damaged = 4;
    const restockable = line.quantityExpected - damaged;

    const inspected = await withTenant(org.organizationId, (tx) =>
      inspectReturn(tx, org.context, created.id, [
        { itemId: line.id, received: line.quantityExpected, restockable, damaged },
      ]),
    );
    expect(inspected.ok).toBe(true);

    // Inspection moves nothing yet.
    expect(await stockOf(org.organizationId, 'CEM-OPC-50')).toEqual(before);

    const completed = await withTenant(org.organizationId, (tx) =>
      completeReturn(tx, org.context, created.id),
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.damaged).toBe(damaged);
    expect(completed.value.restocked[0]!.quantity).toBe(restockable);

    const after = await stockOf(org.organizationId, 'CEM-OPC-50');
    // Only the sellable portion comes back, and reserved is untouched.
    expect(after.availableStock).toBe(before.availableStock + restockable);
    expect(after.reservedStock).toBe(before.reservedStock);

    // Nothing vanished: 80 out, 76 back, 4 damaged, all still readable.
    const view = await withTenant(org.organizationId, (tx) => getReturn(tx, created.id));
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.value.totals.dispatched).toBe(line.quantityDispatched);
      expect(view.value.totals.restockable).toBe(restockable);
      expect(view.value.totals.damaged).toBe(damaged);
      expect(view.value.totals.restockable + view.value.totals.damaged).toBe(
        line.quantityDispatched,
      );
    }

    await assertStockInvariants(org.organizationId);
  });

  it('does not recreate the original reservation', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await returnFor(scenario);
    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.id));
    const items = await owner.returnItem.findMany({ where: { returnId: created.id } });
    await withTenant(org.organizationId, (tx) =>
      inspectReturn(
        tx,
        org.context,
        created.id,
        items.map((item) => ({
          itemId: item.id,
          received: item.quantityExpected,
          restockable: item.quantityExpected,
          damaged: 0,
        })),
      ),
    );
    await withTenant(org.organizationId, (tx) => completeReturn(tx, org.context, created.id));

    // The goods were shipped against that order and the reservation stays consumed. They come
    // back as free stock, because whether this customer still wants them is an open question.
    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: scenario.order.orderId },
    });
    expect(reservations.every((entry) => entry.status === 'CONSUMED')).toBe(true);
    await assertStockInvariants(org.organizationId);
  });

  it('records a movement explaining the restock', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await returnFor(scenario);
    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.id));
    const items = await owner.returnItem.findMany({ where: { returnId: created.id } });
    await withTenant(org.organizationId, (tx) =>
      inspectReturn(tx, org.context, created.id, [
        {
          itemId: items[0]!.id,
          received: items[0]!.quantityExpected,
          restockable: items[0]!.quantityExpected,
          damaged: 0,
        },
      ]),
    );
    await withTenant(org.organizationId, (tx) => completeReturn(tx, org.context, created.id));

    const movements = await withTenant(org.organizationId, (tx) =>
      movementsForProduct(tx, scenario.productId),
    );
    expect(movements[0]).toMatchObject({
      movementType: 'RETURN_RESTOCK',
      delta: items[0]!.quantityExpected,
      relatedReturnId: created.id,
    });
    expect(movements[0]!.reason).toContain(created.returnNumber);
  });

  it('refuses an inspection whose split does not add up', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await returnFor(scenario);
    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.id));
    const item = await owner.returnItem.findFirstOrThrow({ where: { returnId: created.id } });

    const inspected = await withTenant(org.organizationId, (tx) =>
      inspectReturn(tx, org.context, created.id, [
        { itemId: item.id, received: item.quantityExpected, restockable: 1, damaged: 1 },
      ]),
    );
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.error.details?.problem).toBe('SPLIT_DOES_NOT_SUM');
  });

  it('refuses to bring back more than went out, at the database as well', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await returnFor(scenario);
    const item = await owner.returnItem.findFirstOrThrow({ where: { returnId: created.id } });

    await expect(
      owner.returnItem.update({
        where: { id: item.id },
        data: {
          quantityReceived: item.quantityDispatched + 5,
          quantityRestockable: item.quantityDispatched + 5,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses to restock before inspection', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await returnFor(scenario);

    const completed = await withTenant(org.organizationId, (tx) =>
      completeReturn(tx, org.context, created.id),
    );
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('is idempotent — a double-clicked completion restocks once', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await returnFor(scenario);
    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.id));
    const items = await owner.returnItem.findMany({ where: { returnId: created.id } });
    await withTenant(org.organizationId, (tx) =>
      inspectReturn(tx, org.context, created.id, [
        {
          itemId: items[0]!.id,
          received: items[0]!.quantityExpected,
          restockable: items[0]!.quantityExpected,
          damaged: 0,
        },
      ]),
    );
    await withTenant(org.organizationId, (tx) => completeReturn(tx, org.context, created.id));
    const afterFirst = await stockOf(org.organizationId, 'CEM-OPC-50');

    const again = await withTenant(org.organizationId, (tx) =>
      completeReturn(tx, org.context, created.id),
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.alreadyCompleted).toBe(true);
    expect(await stockOf(org.organizationId, 'CEM-OPC-50')).toEqual(afterFirst);
  });

  it('refuses a second live return against the same delivery', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const first = await returnFor(scenario);

    const second = await withTenant(org.organizationId, (tx) =>
      createReturn(tx, org.context, scenario.deliveryId, null),
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.id).toBe(first.id);
    expect(await owner.return.count()).toBe(1);

    // The partial unique index holds even around the module.
    await expect(
      owner.return.create({
        data: {
          organizationId: org.organizationId,
          returnNumber: 'RT-999999',
          salesOrderId: scenario.order.orderId,
          deliveryId: scenario.deliveryId,
          status: 'EXPECTED',
          returnReason: 'OTHER',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('a delivery that is written off', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('restores no stock and completes nothing', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const before = await stockOf(org.organizationId, 'CEM-OPC-50');

    const resolved = await withTenant(org.organizationId, (tx) =>
      resolveDeliveryLoss(tx, org.context, scenario.deliveryId, 'Lorry never arrived at the site.'),
    );
    expect(resolved.ok).toBe(true);

    expect(await stockOf(org.organizationId, 'CEM-OPC-50')).toEqual(before);

    const order = await owner.salesOrder.findUniqueOrThrow({
      where: { id: scenario.order.orderId },
    });
    expect(order.status).toBe('OPEN');
    expect(order.completedAt).toBeNull();
    expect(order.operationalException).toBe('DELIVERY_LOST');

    const delivery = await owner.delivery.findUniqueOrThrow({ where: { id: scenario.deliveryId } });
    // Never marked delivered, and still FAILED.
    expect(delivery.status).toBe('FAILED');
    expect(delivery.failureResolution).toBe('LOST_OR_UNRECOVERABLE');

    const event = await owner.auditEvent.findFirst({ where: { action: 'delivery.written_off' } });
    const state = event!.newState as Record<string, unknown>;
    expect(state.stockRestored).toBe(false);
    expect(state.paymentChanged).toBe(false);
  });

  it('leaves a paid cash order financially untouched', async () => {
    // §27, the case that must not be got wrong: money arrived, goods did not.
    const scenario = await failedDelivery(org);
    const paymentsBefore = await owner.payment.findMany({
      where: { salesOrderId: scenario.order.orderId },
    });
    expect(paymentsBefore.every((payment) => payment.status === 'CONFIRMED')).toBe(true);

    await withTenant(org.organizationId, (tx) =>
      resolveDeliveryLoss(tx, org.context, scenario.deliveryId, 'Vehicle stolen.'),
    );

    const order = await owner.salesOrder.findUniqueOrThrow({
      where: { id: scenario.order.orderId },
    });
    expect(order.paymentStatus).toBe('PAID');

    const paymentsAfter = await owner.payment.findMany({
      where: { salesOrderId: scenario.order.orderId },
    });
    expect(paymentsAfter).toHaveLength(paymentsBefore.length);
    for (const payment of paymentsBefore) {
      const match = paymentsAfter.find((candidate) => candidate.id === payment.id)!;
      expect(match.status).toBe('CONFIRMED');
      expect(match.amountConfirmedMinor).toBe(payment.amountConfirmedMinor);
    }

    const balance = await withTenant(org.organizationId, (tx) =>
      orderBalance(tx, scenario.order.orderId),
    );
    expect(balance.ok).toBe(true);
    if (balance.ok) expect(balance.value.outstandingMinor).toBe(0n);
  });

  it('refuses a second resolution of the same failure', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    await withTenant(org.organizationId, (tx) =>
      resolveDeliveryLoss(tx, org.context, scenario.deliveryId, 'gone'),
    );

    const retry = await withTenant(org.organizationId, (tx) =>
      createDeliveryRetry(tx, org.context, scenario.deliveryId),
    );
    expect(retry.ok).toBe(false);

    const returned = await withTenant(org.organizationId, (tx) =>
      createReturn(tx, org.context, scenario.deliveryId, null),
    );
    expect(returned.ok).toBe(false);
  });

  it('never routes an exception through order cancellation', async () => {
    // §28. The order progressed well beyond the cancellation boundary; calling cancelOrder
    // would try to release consumed reservations and erase four phases of history.
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    await withTenant(org.organizationId, (tx) =>
      resolveDeliveryLoss(tx, org.context, scenario.deliveryId, 'gone'),
    );

    const order = await owner.salesOrder.findUniqueOrThrow({
      where: { id: scenario.order.orderId },
    });
    expect(order.status).not.toBe('CANCELLED');
    expect(order.cancelledAt).toBeNull();

    const reservations = await owner.stockReservation.findMany({
      where: { salesOrderId: scenario.order.orderId },
    });
    expect(reservations.every((entry) => entry.status === 'CONSUMED')).toBe(true);
  });

  it('shows an unresolved failure in the exceptions list with its money state', async () => {
    const scenario = await failedDelivery(org);

    const rows = await withTenant(org.organizationId, (tx) => unresolvedFailures(tx));
    const mine = rows.find((row) => row.id === scenario.deliveryId);
    expect(mine).toBeDefined();
    expect(mine!.paymentSettled).toBe(true);
    expect(mine!.failureReason).toBe('CUSTOMER_UNAVAILABLE');

    await withTenant(org.organizationId, (tx) =>
      resolveDeliveryLoss(tx, org.context, scenario.deliveryId, 'gone'),
    );
    const after = await withTenant(org.organizationId, (tx) => unresolvedFailures(tx));
    expect(after.find((row) => row.id === scenario.deliveryId)).toBeUndefined();
  });
});

describe('concurrency', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('A — two users reconciling one discrepancy adjust stock once', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    const counted = product.availableStock - 40;
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, { productId: product.id, physicalCount: counted }),
    );
    if (!reported.ok) return;

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) =>
        reconcileDiscrepancy(tx, org.context, reported.value.id, null),
      ),
      withTenant(org.organizationId, (tx) =>
        reconcileDiscrepancy(tx, org.context, reported.value.id, null),
      ),
    ]);

    // Exactly one applied; the other found it done or found the baseline moved.
    const applied = results.filter((result) => result.ok && result.value.applied);
    expect(applied).toHaveLength(1);

    const after = await owner.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.availableStock).toBe(counted);
    expect(
      await owner.inventoryMovement.count({
        where: { productId: product.id, movementType: 'DISCREPANCY_RECONCILIATION' },
      }),
    ).toBe(1);
  });

  it('B — reconciliation racing a handover leaves one coherent outcome', async () => {
    const prepared = await preparedTask(org, { paymentType: 'CREDIT' });
    const product = await owner.product.findUniqueOrThrow({ where: { id: prepared.productId } });

    // A count that still covers the committed quantity, so both operations are individually
    // legal and the race is genuinely about ordering.
    const counted = product.availableStock - 1;
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: prepared.productId,
        physicalCount: counted,
        // Deliberately not attached to the task: attaching it would block the handover outright
        // and there would be no race to observe.
      }),
    );
    if (!reported.ok) return;

    const [reconciled, completed] = await Promise.all([
      withTenant(org.organizationId, (tx) =>
        reconcileDiscrepancy(tx, org.context, reported.value.id, null),
      ),
      withTenant(org.organizationId, (tx) =>
        completeWarehouseTask(tx, org.context, prepared.taskId),
      ),
    ]);

    const after = await owner.product.findUniqueOrThrow({ where: { id: prepared.productId } });

    if (reconciled.ok && reconciled.value.applied && completed.ok) {
      // Both landed, serialised by the product lock: the count applied and the shipment left.
      expect(after.availableStock).toBe(counted - prepared.quantity);
    } else if (completed.ok) {
      // The handover won; the reconciliation refused rather than writing a stale delta.
      expect(reconciled.ok).toBe(false);
      expect(after.availableStock).toBe(product.availableStock - prepared.quantity);
    } else {
      expect(reconciled.ok).toBe(true);
      expect(after.availableStock).toBe(counted);
    }

    // Never a double decrement, whichever way it fell.
    expect(after.availableStock).toBeGreaterThanOrEqual(
      product.availableStock - prepared.quantity - 1,
    );
    await assertStockInvariants(org.organizationId);
  });

  it('C — a double-clicked return completion restocks exactly once', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await withTenant(org.organizationId, (tx) =>
      createReturn(tx, org.context, scenario.deliveryId, null),
    );
    if (!created.ok) return;
    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.value.id));
    const items = await owner.returnItem.findMany({ where: { returnId: created.value.id } });
    await withTenant(org.organizationId, (tx) =>
      inspectReturn(tx, org.context, created.value.id, [
        {
          itemId: items[0]!.id,
          received: items[0]!.quantityExpected,
          restockable: items[0]!.quantityExpected,
          damaged: 0,
        },
      ]),
    );

    const before = await stockOf(org.organizationId, 'CEM-OPC-50');

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) => completeReturn(tx, org.context, created.value.id)),
      withTenant(org.organizationId, (tx) => completeReturn(tx, org.context, created.value.id)),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    const didWork = results.filter((result) => result.ok && !result.value.alreadyCompleted);
    expect(didWork).toHaveLength(1);

    const after = await stockOf(org.organizationId, 'CEM-OPC-50');
    expect(after.availableStock).toBe(before.availableStock + items[0]!.quantityExpected);
    expect(
      await owner.inventoryMovement.count({ where: { movementType: 'RETURN_RESTOCK' } }),
    ).toBe(1);
  });

  it('D — a return completing while a retry is created cannot produce both', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await withTenant(org.organizationId, (tx) =>
      createReturn(tx, org.context, scenario.deliveryId, null),
    );
    if (!created.ok) return;
    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.value.id));
    const items = await owner.returnItem.findMany({ where: { returnId: created.value.id } });
    await withTenant(org.organizationId, (tx) =>
      inspectReturn(tx, org.context, created.value.id, [
        {
          itemId: items[0]!.id,
          received: items[0]!.quantityExpected,
          restockable: items[0]!.quantityExpected,
          damaged: 0,
        },
      ]),
    );

    const [restocked, retry] = await Promise.all([
      withTenant(org.organizationId, (tx) => completeReturn(tx, org.context, created.value.id)),
      withTenant(org.organizationId, (tx) =>
        createDeliveryRetry(tx, org.context, scenario.deliveryId),
      ),
    ]);

    // The contradiction §35D forbids: goods back on the shelf *and* an attempt to deliver the
    // same goods, with no stock consumed for the second trip.
    const returnRow = await owner.return.findUniqueOrThrow({ where: { id: created.value.id } });
    const retries = await owner.delivery.count({
      where: { retryOfDeliveryId: scenario.deliveryId, status: { not: 'CANCELLED' } },
    });

    expect(returnRow.status === 'COMPLETED' && retries > 0).toBe(false);
    if (returnRow.status === 'COMPLETED') expect(retry.ok).toBe(false);
    else expect(restocked.ok).toBe(false);

    await assertStockInvariants(org.organizationId);
  });

  it('E — two returns against the same failed delivery resolve to one', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) =>
        createReturn(tx, org.context, scenario.deliveryId, null),
      ),
      withTenant(org.organizationId, (tx) =>
        createReturn(tx, org.context, scenario.deliveryId, null),
      ),
    ]);

    const succeeded = results.filter((result) => result.ok);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(await owner.return.count({ where: { deliveryId: scenario.deliveryId } })).toBe(1);
  });

  it('F — a double-clicked retry produces one new attempt', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) =>
        createDeliveryRetry(tx, org.context, scenario.deliveryId),
      ),
      withTenant(org.organizationId, (tx) =>
        createDeliveryRetry(tx, org.context, scenario.deliveryId),
      ),
    ]);

    const created = results.filter((result) => result.ok);
    expect(created.length).toBeGreaterThanOrEqual(1);
    // One failed attempt must never put two vehicles on the road.
    expect(
      await owner.delivery.count({ where: { retryOfDeliveryId: scenario.deliveryId } }),
    ).toBe(1);
  });

  it('G — two organizations resolving exceptions at once do not touch each other', async () => {
    const other = await seedOrg('Bole Trading', 'OWNER_ADMIN');
    await seedCatalogue(other.organizationId);

    const mine = await failedDelivery(org, { paymentType: 'CREDIT' });
    const theirs = await failedDelivery(other, { paymentType: 'CREDIT' });

    const results = await Promise.all([
      withTenant(org.organizationId, (tx) => createDeliveryRetry(tx, org.context, mine.deliveryId)),
      withTenant(other.organizationId, (tx) =>
        createDeliveryRetry(tx, other.context, theirs.deliveryId),
      ),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    await assertStockInvariants(org.organizationId);
    await assertStockInvariants(other.organizationId);
  });
});

describe('tenant isolation', () => {
  let orgA: Org;
  let orgB: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    orgA = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    orgB = await seedOrg('Bole Trading', 'OWNER_ADMIN');
    await seedCatalogue(orgA.organizationId);
    await seedCatalogue(orgB.organizationId);
  });

  it('cannot read or resolve another organization’s discrepancy', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: orgB.organizationId, sku: 'HB-20' },
    });
    const reported = await withTenant(orgB.organizationId, (tx) =>
      reportDiscrepancy(tx, orgB.context, {
        productId: product.id,
        physicalCount: product.availableStock - 20,
      }),
    );
    if (!reported.ok) return;

    expect((await withTenant(orgA.organizationId, (tx) => getDiscrepancy(tx, reported.value.id))).ok).toBe(
      false,
    );

    for (const attempt of [
      () =>
        withTenant(orgA.organizationId, (tx) =>
          reviewDiscrepancy(tx, orgA.context, reported.value.id),
        ),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          reconcileDiscrepancy(tx, orgA.context, reported.value.id, null),
        ),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          cancelDiscrepancy(tx, orgA.context, reported.value.id, 'not mine'),
        ),
    ]) {
      const result = await attempt();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
    }

    // Untouched, and readable by its owner — so the isolation assertion is not vacuous.
    const row = await owner.inventoryDiscrepancy.findUniqueOrThrow({
      where: { id: reported.value.id },
    });
    expect(row.status).toBe('OPEN');
    expect(
      (await withTenant(orgB.organizationId, (tx) => getDiscrepancy(tx, reported.value.id))).ok,
    ).toBe(true);
    expect(
      (await owner.product.findUniqueOrThrow({ where: { id: product.id } })).availableStock,
    ).toBe(product.availableStock);
  });

  it('cannot touch another organization’s return or retry their delivery', async () => {
    const theirs = await failedDelivery(orgB, { paymentType: 'CREDIT' });
    const created = await withTenant(orgB.organizationId, (tx) =>
      createReturn(tx, orgB.context, theirs.deliveryId, null),
    );
    if (!created.ok) return;

    expect((await withTenant(orgA.organizationId, (tx) => getReturn(tx, created.value.id))).ok).toBe(
      false,
    );

    for (const attempt of [
      () =>
        withTenant(orgA.organizationId, (tx) => receiveReturn(tx, orgA.context, created.value.id)),
      () =>
        withTenant(orgA.organizationId, (tx) => completeReturn(tx, orgA.context, created.value.id)),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          createDeliveryRetry(tx, orgA.context, theirs.deliveryId),
        ),
      () =>
        withTenant(orgA.organizationId, (tx) =>
          resolveDeliveryLoss(tx, orgA.context, theirs.deliveryId, 'not mine'),
        ),
    ]) {
      const result = await attempt();
      expect(result.ok).toBe(false);
    }

    const row = await owner.return.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(row.status).toBe('EXPECTED');
    expect(await owner.delivery.count({ where: { retryOfDeliveryId: theirs.deliveryId } })).toBe(0);
  });

  it('cannot reduce another organization’s reservation', async () => {
    const prepared = await preparedTask(orgB, { paymentType: 'CREDIT' });
    const reservation = await owner.stockReservation.findFirstOrThrow({
      where: { salesOrderId: prepared.order.orderId, status: 'ACTIVE' },
    });

    const result = await withTenant(orgA.organizationId, (tx) =>
      resolveReservationShortfall(tx, orgA.context, reservation.id, 1, 'not mine'),
    );
    expect(result.ok).toBe(false);

    const after = await owner.stockReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(after.quantity).toBe(reservation.quantity);
    expect(after.status).toBe('ACTIVE');
  });

  it('keeps the exception lists inside one organization', async () => {
    await failedDelivery(orgB, { paymentType: 'CREDIT' });
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: orgB.organizationId, sku: 'HB-20' },
    });
    await withTenant(orgB.organizationId, (tx) =>
      reportDiscrepancy(tx, orgB.context, { productId: product.id, physicalCount: 1 }),
    );

    expect(await withTenant(orgA.organizationId, (tx) => inventoryExceptions(tx))).toHaveLength(0);
    expect(await withTenant(orgA.organizationId, (tx) => returnQueue(tx))).toHaveLength(0);
    expect(await withTenant(orgA.organizationId, (tx) => unresolvedFailures(tx))).toHaveLength(0);
    expect(
      (await withTenant(orgB.organizationId, (tx) => inventoryExceptions(tx))).length,
    ).toBeGreaterThan(0);
  });

  it('treats a malformed or unknown id as not found', async () => {
    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      expect((await withTenant(orgA.organizationId, (tx) => getDiscrepancy(tx, id))).ok).toBe(false);
      expect((await withTenant(orgA.organizationId, (tx) => getReturn(tx, id))).ok).toBe(false);
      expect(
        (await withTenant(orgA.organizationId, (tx) => createDeliveryRetry(tx, orgA.context, id)))
          .ok,
      ).toBe(false);
      expect(
        (
          await withTenant(orgA.organizationId, (tx) =>
            resolveReservationShortfall(tx, orgA.context, id, 0, 'x'),
          )
        ).ok,
      ).toBe(false);
    }
  });
});

describe('audit', () => {
  let org: Org;

  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    org = await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
    await seedCatalogue(org.organizationId);
  });

  it('rolls back the whole reconciliation when the transaction fails', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { organizationId: org.organizationId, sku: 'HB-20' },
    });
    const reported = await withTenant(org.organizationId, (tx) =>
      reportDiscrepancy(tx, org.context, {
        productId: product.id,
        physicalCount: product.availableStock - 10,
      }),
    );
    if (!reported.ok) return;

    await expect(
      withTenant(org.organizationId, async (tx) => {
        const result = await reconcileDiscrepancy(tx, org.context, reported.value.id, null);
        expect(result.ok).toBe(true);
        throw new Error('something later in the request failed');
      }),
    ).rejects.toThrow('something later in the request failed');

    // Stock, the ledger, the discrepancy and the audit trail unwind together.
    expect(
      (await owner.product.findUniqueOrThrow({ where: { id: product.id } })).availableStock,
    ).toBe(product.availableStock);
    expect(await owner.inventoryMovement.count({ where: { productId: product.id } })).toBe(0);
    expect(
      (await owner.inventoryDiscrepancy.findUniqueOrThrow({ where: { id: reported.value.id } }))
        .status,
    ).toBe('OPEN');
    expect(
      await owner.auditEvent.count({ where: { action: 'inventory_discrepancy.reconciled' } }),
    ).toBe(0);
  });

  it('records the exception trail end to end', async () => {
    const scenario = await failedDelivery(org, { paymentType: 'CREDIT' });
    const created = await withTenant(org.organizationId, (tx) =>
      createReturn(tx, org.context, scenario.deliveryId, null),
    );
    if (!created.ok) return;
    await withTenant(org.organizationId, (tx) => receiveReturn(tx, org.context, created.value.id));
    const items = await owner.returnItem.findMany({ where: { returnId: created.value.id } });
    await withTenant(org.organizationId, (tx) =>
      inspectReturn(tx, org.context, created.value.id, [
        {
          itemId: items[0]!.id,
          received: items[0]!.quantityExpected,
          restockable: items[0]!.quantityExpected - 2,
          damaged: 2,
        },
      ]),
    );
    await withTenant(org.organizationId, (tx) => completeReturn(tx, org.context, created.value.id));

    const actions = (
      await owner.auditEvent.findMany({
        where: { organizationId: org.organizationId },
        orderBy: { sequence: 'asc' },
      })
    ).map((event) => event.action);

    for (const expected of [
      'return.created',
      'return.received',
      'return.inspected',
      'stock.restocked_from_return',
      'return.completed',
    ]) {
      expect(actions, `missing ${expected}`).toContain(expected);
    }

    const completion = await owner.auditEvent.findFirstOrThrow({
      where: { action: 'return.completed' },
    });
    const state = completion.newState as Record<string, unknown>;
    expect(state.reservationRecreated).toBe(false);
    expect(state.paymentChanged).toBe(false);
    expect(state.damaged).toBe(2);
  });
});
