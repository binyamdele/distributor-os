import 'server-only';
import type { TenantTransaction } from '@/platform/db';

/**
 * Phase 6 instrumentation.
 *
 * Queries over the operational tables, as in Phases 2 and 4. No stored counters and no
 * scheduler: every figure is derived when it is asked for, so it cannot drift from the rows it
 * claims to summarise.
 *
 * The two numbers a distributor will act on first are the backlog and the failed-delivery rate.
 * A backlog means paid orders sitting unpicked, which is money already taken and goods not
 * delivered. A failure rate means fuel and a driver's day spent on runs that did not land, and
 * it is the one figure here that points at a problem outside the warehouse — usually addresses.
 */

export interface FulfillmentMetrics {
  /** Orders that have cleared their gate and have no task raised yet. */
  readonly awaitingWarehouse: number;
  /** Tasks raised and not yet handed over — the floor's backlog. */
  readonly openTasks: number;
  readonly pendingTasks: number;
  readonly inProgressTasks: number;
  readonly preparedTasks: number;
  readonly completedTasks: number;
  /** Mean hours between the task being raised and someone starting it. */
  readonly averageHoursToStart: number | null;
  /** Mean hours between starting and picking the last line. */
  readonly averageHoursToPrepare: number | null;
  /** Mean hours between the task being raised and the goods leaving. */
  readonly averageHoursToHandover: number | null;
}

function meanHours(pairs: readonly (readonly [Date | null, Date | null])[]): number | null {
  const spans = pairs
    .filter((pair): pair is readonly [Date, Date] => pair[0] !== null && pair[1] !== null)
    .map(([from, to]) => (to.getTime() - from.getTime()) / 3_600_000)
    // A negative span means clock skew or a backdated fixture. Excluded rather than averaged in,
    // because one negative outlier makes the whole figure quietly wrong.
    .filter((hours) => hours >= 0);

  if (spans.length === 0) return null;
  return Math.round((spans.reduce((sum, hours) => sum + hours, 0) / spans.length) * 10) / 10;
}

export async function fulfillmentMetrics(tx: TenantTransaction): Promise<FulfillmentMetrics> {
  const tasks = await tx.warehouseTask.findMany({
    where: { status: { not: 'CANCELLED' } },
    select: {
      status: true,
      createdAt: true,
      startedAt: true,
      preparedAt: true,
      completedAt: true,
    },
  });

  const awaitingWarehouse = await tx.salesOrder.count({
    where: {
      status: 'OPEN',
      fulfillmentStatus: 'READY',
      warehouseTasks: { none: { status: { not: 'CANCELLED' } } },
    },
  });

  const count = (status: string) => tasks.filter((task) => task.status === status).length;

  return {
    awaitingWarehouse,
    openTasks: tasks.filter((task) => task.status !== 'COMPLETED').length,
    pendingTasks: count('PENDING'),
    inProgressTasks: count('IN_PROGRESS'),
    preparedTasks: count('PREPARED'),
    completedTasks: count('COMPLETED'),
    averageHoursToStart: meanHours(tasks.map((task) => [task.createdAt, task.startedAt] as const)),
    averageHoursToPrepare: meanHours(
      tasks.map((task) => [task.startedAt, task.preparedAt] as const),
    ),
    averageHoursToHandover: meanHours(
      tasks.map((task) => [task.createdAt, task.completedAt] as const),
    ),
  };
}

export interface DeliveryMetrics {
  readonly pending: number;
  readonly assigned: number;
  readonly dispatched: number;
  readonly delivered: number;
  readonly failed: number;
  /** Failed / (delivered + failed). Null before anything has been attempted. */
  readonly failureRate: number | null;
  readonly failureReasons: Readonly<Record<string, number>>;
  /** Mean hours between dispatch and arrival. */
  readonly averageHoursOnTheRoad: number | null;
}

export async function deliveryMetrics(tx: TenantTransaction): Promise<DeliveryMetrics> {
  const deliveries = await tx.delivery.findMany({
    select: {
      status: true,
      failureReason: true,
      dispatchedAt: true,
      deliveredAt: true,
    },
  });

  const count = (status: string) => deliveries.filter((row) => row.status === status).length;
  const delivered = count('DELIVERED');
  const failed = count('FAILED');
  const attempted = delivered + failed;

  const failureReasons: Record<string, number> = {};
  for (const row of deliveries) {
    if (row.status !== 'FAILED' || !row.failureReason) continue;
    failureReasons[row.failureReason] = (failureReasons[row.failureReason] ?? 0) + 1;
  }

  return {
    pending: count('PENDING'),
    assigned: count('ASSIGNED'),
    dispatched: count('DISPATCHED'),
    delivered,
    failed,
    failureRate: attempted === 0 ? null : Math.round((failed / attempted) * 1000) / 1000,
    failureReasons,
    averageHoursOnTheRoad: meanHours(
      deliveries.map((row) => [row.dispatchedAt, row.deliveredAt] as const),
    ),
  };
}

export interface ConsumedStockRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly unit: string;
  readonly quantityConsumed: number;
  readonly orderCount: number;
}

/**
 * What has actually shipped, by product.
 *
 * Derived from CONSUMED reservations rather than from the audit log, because the reservations
 * are the operational record and the log is a description of it. They should agree; if they ever
 * do not, this figure is the one that matches the stock on the floor.
 */
export async function consumedStockByProduct(
  tx: TenantTransaction,
): Promise<ConsumedStockRow[]> {
  const rows = await tx.stockReservation.groupBy({
    by: ['productId'],
    where: { status: 'CONSUMED' },
    _sum: { quantity: true },
    _count: { salesOrderId: true },
  });

  if (rows.length === 0) return [];

  const products = await tx.product.findMany({
    where: { id: { in: rows.map((row) => row.productId) } },
    select: { id: true, sku: true, name: true, unit: true },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  return rows
    .map((row) => {
      const product = byId.get(row.productId);
      return {
        productId: row.productId,
        sku: product?.sku ?? '—',
        name: product?.name ?? '—',
        unit: product?.unit ?? '',
        quantityConsumed: row._sum.quantity ?? 0,
        orderCount: row._count.salesOrderId,
      };
    })
    .sort((a, b) => b.quantityConsumed - a.quantityConsumed);
}

/**
 * Mean hours between an order becoming fulfillable and its operational completion.
 *
 * Measured from order creation for a credit order (ready immediately) and from the payment
 * confirmation for a cash one — but both are approximated here by the warehouse task's creation
 * time, which is the first moment the order was demonstrably eligible. Stated plainly rather
 * than dressed up as an exact acceptance-to-delivery figure the data cannot support.
 */
export async function averageHoursTaskToCompletion(
  tx: TenantTransaction,
): Promise<number | null> {
  const orders = await tx.salesOrder.findMany({
    where: { status: 'COMPLETED', completedAt: { not: null } },
    select: {
      completedAt: true,
      warehouseTasks: {
        where: { status: { not: 'CANCELLED' } },
        select: { createdAt: true },
        take: 1,
      },
    },
  });

  return meanHours(
    orders.map((order) => [order.warehouseTasks[0]?.createdAt ?? null, order.completedAt] as const),
  );
}
