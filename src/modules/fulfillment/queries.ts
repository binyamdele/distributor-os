import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import { isUuid } from '@/platform/ids';
import { type Result, fail, ok } from '@/platform/result';
import { assessEligibility } from './state';
import type { DeliveryStatus, WarehouseTaskStatus } from './state';

/**
 * Reads for the warehouse floor and the delivery queue.
 *
 * One rule shapes all of them: **the warehouse sees what it needs to execute, and no more.**
 * A picker needs an order number, a customer name, a SKU, a unit and a quantity. They do not
 * need the line price, the discount, the customer's credit limit, or a bank slip. Passing the
 * financial columns through "because they are on the row anyway" is how a customer's payment
 * evidence ends up on a screen in a warehouse.
 */

export interface WarehouseQueueRow {
  readonly id: string;
  readonly taskNumber: string;
  readonly status: WarehouseTaskStatus;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly lineCount: number;
  readonly totalUnits: number;
  readonly preparedCount: number;
  readonly deliveryRequired: boolean;
  readonly assignedUserName: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  /**
   * Whether the money side is settled — a boolean, not an amount.
   *
   * The warehouse needs to know that an order cleared its gate, because that is what makes it
   * pickable. It does not need to know how much, by what method, or on whose receipt.
   */
  readonly paymentCleared: boolean;
  readonly paymentType: string;
}

export async function warehouseQueue(
  tx: TenantTransaction,
  options: { statuses?: readonly WarehouseTaskStatus[] } = {},
): Promise<WarehouseQueueRow[]> {
  const statuses = options.statuses ?? (['PENDING', 'IN_PROGRESS', 'PREPARED'] as const);

  const tasks = await tx.warehouseTask.findMany({
    where: { status: { in: [...statuses] } },
    // Oldest first: the order that has been waiting longest is the customer most likely to be
    // asking. Anything cleverer would need justifying to the person working the list.
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: {
      items: true,
      assignedUser: { select: { fullName: true } },
      salesOrder: {
        select: {
          id: true,
          orderNumber: true,
          deliveryRequired: true,
          paymentStatus: true,
          paymentType: true,
          customer: { select: { companyName: true } },
        },
      },
    },
  });

  return tasks.map((task) => ({
    id: task.id,
    taskNumber: task.taskNumber,
    status: task.status as WarehouseTaskStatus,
    orderId: task.salesOrder.id,
    orderNumber: task.salesOrder.orderNumber,
    customerName: task.salesOrder.customer.companyName,
    lineCount: task.items.length,
    totalUnits: task.items.reduce((sum, item) => sum + item.quantityRequired, 0),
    preparedCount: task.items.filter((item) => item.status === 'PREPARED').length,
    deliveryRequired: task.salesOrder.deliveryRequired,
    assignedUserName: task.assignedUser?.fullName ?? null,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    paymentCleared:
      task.salesOrder.paymentStatus === 'PAID' ||
      task.salesOrder.paymentStatus === 'NOT_REQUIRED_YET',
    paymentType: task.salesOrder.paymentType,
  }));
}

export interface WarehouseTaskItemView {
  readonly id: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly quantityRequired: number;
  readonly prepared: boolean;
  /** The live reservation position for this line, so a mismatch is visible before completion. */
  readonly activeReservedQuantity: number;
  readonly onHand: number | null;
}

export interface WarehouseTaskView {
  readonly id: string;
  readonly taskNumber: string;
  readonly status: WarehouseTaskStatus;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly preparedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancellationReason: string | null;
  readonly assignedUserName: string | null;
  readonly order: {
    readonly id: string;
    readonly orderNumber: string;
    readonly status: string;
    readonly paymentType: string;
    readonly deliveryRequired: boolean;
    readonly deliveryAddress: string | null;
    readonly pickedUpAt: Date | null;
  };
  readonly customer: { readonly companyName: string; readonly phone: string | null };
  readonly items: readonly WarehouseTaskItemView[];
  readonly delivery: { readonly id: string; readonly deliveryNumber: string; readonly status: DeliveryStatus } | null;
  /** Every line's reservation exactly covers what must be handed over. */
  readonly reservationsAgree: boolean;
}

export async function getWarehouseTask(
  tx: TenantTransaction,
  taskId: string,
): Promise<Result<WarehouseTaskView>> {
  if (!isUuid(taskId)) return fail('NOT_FOUND', 'error.notFound');

  const task = await tx.warehouseTask.findFirst({
    where: { id: taskId },
    include: {
      items: { orderBy: { createdAt: 'asc' }, include: { product: { select: { availableStock: true } } } },
      assignedUser: { select: { fullName: true } },
      deliveries: { where: { status: { notIn: ['CANCELLED'] } } },
      salesOrder: { include: { customer: true } },
    },
  });
  if (!task) return fail('NOT_FOUND', 'error.notFound');

  const reservations = await tx.stockReservation.groupBy({
    by: ['productId'],
    where: { salesOrderId: task.salesOrderId, status: 'ACTIVE' },
    _sum: { quantity: true },
  });
  const activeByProduct = new Map(
    reservations.map((row) => [row.productId, row._sum.quantity ?? 0]),
  );

  const items = task.items.map((item) => ({
    id: item.id,
    sku: item.skuSnapshot,
    description: item.descriptionSnapshot,
    unit: item.unitSnapshot,
    quantityRequired: item.quantityRequired,
    prepared: item.status === 'PREPARED',
    activeReservedQuantity: item.productId ? (activeByProduct.get(item.productId) ?? 0) : 0,
    onHand: item.product?.availableStock ?? null,
  }));

  // Compared per product, because two lines can name the same one and the reservation is held
  // against the product rather than the line.
  const requiredByProduct = new Map<string, number>();
  for (const item of task.items) {
    if (!item.productId) continue;
    requiredByProduct.set(
      item.productId,
      (requiredByProduct.get(item.productId) ?? 0) + item.quantityRequired,
    );
  }
  const reservationsAgree =
    task.status === 'COMPLETED' ||
    [...requiredByProduct].every(
      ([productId, quantity]) => (activeByProduct.get(productId) ?? 0) === quantity,
    );

  const delivery = task.deliveries[0];

  return ok({
    id: task.id,
    taskNumber: task.taskNumber,
    status: task.status as WarehouseTaskStatus,
    notes: task.notes,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    preparedAt: task.preparedAt,
    completedAt: task.completedAt,
    cancellationReason: task.cancellationReason,
    assignedUserName: task.assignedUser?.fullName ?? null,
    order: {
      id: task.salesOrder.id,
      orderNumber: task.salesOrder.orderNumber,
      status: task.salesOrder.status,
      paymentType: task.salesOrder.paymentType,
      deliveryRequired: task.salesOrder.deliveryRequired,
      deliveryAddress: task.salesOrder.deliveryAddressSnapshot,
      pickedUpAt: task.salesOrder.pickedUpAt,
    },
    customer: {
      companyName: task.salesOrder.customer.companyName,
      phone: task.salesOrder.customer.phone,
    },
    items,
    delivery: delivery
      ? {
          id: delivery.id,
          deliveryNumber: delivery.deliveryNumber,
          status: delivery.status as DeliveryStatus,
        }
      : null,
    reservationsAgree,
  });
}

/** Orders that have cleared their gate and have no task yet — the "raise a task" list. */
export interface FulfillableOrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly lineCount: number;
  readonly deliveryRequired: boolean;
  readonly paymentType: string;
  readonly readySince: Date;
}

export async function ordersAwaitingWarehouse(
  tx: TenantTransaction,
): Promise<FulfillableOrderRow[]> {
  const orders = await tx.salesOrder.findMany({
    where: {
      status: 'OPEN',
      fulfillmentStatus: 'READY',
      warehouseTasks: { none: { status: { not: 'CANCELLED' } } },
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: {
      customer: { select: { companyName: true } },
      items: { select: { reservedQuantity: true } },
    },
  });

  return orders
    .filter((order) => {
      // The same stored-state check the creation path makes, so the list never offers a button
      // that would be refused.
      const reserved = order.items.filter((item) => item.reservedQuantity > 0).length;
      return assessEligibility(
        {
          status: order.status,
          paymentStatus: order.paymentStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          paymentType: order.paymentType as 'CASH' | 'CREDIT',
        },
        reserved,
      ).eligible;
    })
    .map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customer.companyName,
      lineCount: order.items.filter((item) => item.reservedQuantity > 0).length,
      deliveryRequired: order.deliveryRequired,
      paymentType: order.paymentType,
      readySince: order.createdAt,
    }));
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export interface DeliveryRow {
  readonly id: string;
  readonly deliveryNumber: string;
  readonly status: DeliveryStatus;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly destination: string;
  readonly driverName: string | null;
  readonly driverPhone: string | null;
  readonly vehicleReference: string | null;
  readonly dispatchedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
}

export async function deliveryQueue(
  tx: TenantTransaction,
  options: { statuses?: readonly DeliveryStatus[] } = {},
): Promise<DeliveryRow[]> {
  const deliveries = await tx.delivery.findMany({
    where: options.statuses ? { status: { in: [...options.statuses] } } : undefined,
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: { salesOrder: { select: { id: true, orderNumber: true } } },
  });

  return deliveries.map((delivery) => ({
    id: delivery.id,
    deliveryNumber: delivery.deliveryNumber,
    status: delivery.status as DeliveryStatus,
    orderId: delivery.salesOrder.id,
    orderNumber: delivery.salesOrder.orderNumber,
    // The snapshots, always. Never the customer's current row.
    customerName: delivery.customerNameSnapshot,
    customerPhone: delivery.customerPhoneSnapshot,
    destination: delivery.destinationTextSnapshot,
    driverName: delivery.assignedDriverName,
    driverPhone: delivery.assignedDriverPhone,
    vehicleReference: delivery.vehicleReference,
    dispatchedAt: delivery.dispatchedAt,
    deliveredAt: delivery.deliveredAt,
    failedAt: delivery.failedAt,
    failureReason: delivery.failureReason,
    createdAt: delivery.createdAt,
  }));
}

export async function getDelivery(
  tx: TenantTransaction,
  deliveryId: string,
): Promise<Result<DeliveryRow & { deliveryNote: string | null; failureNote: string | null }>> {
  if (!isUuid(deliveryId)) return fail('NOT_FOUND', 'error.notFound');

  const delivery = await tx.delivery.findFirst({
    where: { id: deliveryId },
    include: { salesOrder: { select: { id: true, orderNumber: true } } },
  });
  if (!delivery) return fail('NOT_FOUND', 'error.notFound');

  return ok({
    id: delivery.id,
    deliveryNumber: delivery.deliveryNumber,
    status: delivery.status as DeliveryStatus,
    orderId: delivery.salesOrder.id,
    orderNumber: delivery.salesOrder.orderNumber,
    customerName: delivery.customerNameSnapshot,
    customerPhone: delivery.customerPhoneSnapshot,
    destination: delivery.destinationTextSnapshot,
    driverName: delivery.assignedDriverName,
    driverPhone: delivery.assignedDriverPhone,
    vehicleReference: delivery.vehicleReference,
    dispatchedAt: delivery.dispatchedAt,
    deliveredAt: delivery.deliveredAt,
    failedAt: delivery.failedAt,
    failureReason: delivery.failureReason,
    createdAt: delivery.createdAt,
    deliveryNote: delivery.deliveryNote,
    failureNote: delivery.failureNote,
  });
}

/** The fulfilment position for one order, for the order screen. */
export async function fulfillmentForOrder(
  tx: TenantTransaction,
  salesOrderId: string,
): Promise<{
  task: { id: string; taskNumber: string; status: WarehouseTaskStatus } | null;
  delivery: { id: string; deliveryNumber: string; status: DeliveryStatus } | null;
}> {
  if (!isUuid(salesOrderId)) return { task: null, delivery: null };

  const task = await tx.warehouseTask.findFirst({
    where: { salesOrderId, status: { not: 'CANCELLED' } },
  });
  const delivery = await tx.delivery.findFirst({
    where: { salesOrderId, status: { not: 'CANCELLED' } },
    orderBy: { createdAt: 'desc' },
  });

  return {
    task: task
      ? { id: task.id, taskNumber: task.taskNumber, status: task.status as WarehouseTaskStatus }
      : null,
    delivery: delivery
      ? {
          id: delivery.id,
          deliveryNumber: delivery.deliveryNumber,
          status: delivery.status as DeliveryStatus,
        }
      : null,
  };
}
