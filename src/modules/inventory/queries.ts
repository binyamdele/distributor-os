import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import { isUuid } from '@/platform/ids';
import { type Result, fail, ok } from '@/platform/result';
import type { DiscrepancyStatus, DiscrepancyType } from './discrepancy';
import type { ReturnStatus } from './returns-model';

/**
 * Reads for the exceptions list, the discrepancy detail and the return detail.
 *
 * The warehouse rule from Phase 6 holds here too: a person processing a physical return needs a
 * SKU, a unit and three quantities. They do not need the line price, the order total, or the
 * customer's payment evidence — so none of it is on these views, and it is absent by
 * construction rather than by being hidden in the template.
 */

export interface DiscrepancyRow {
  readonly id: string;
  readonly discrepancyNumber: string;
  readonly status: DiscrepancyStatus;
  readonly discrepancyType: DiscrepancyType;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly systemOnHand: number;
  readonly systemReserved: number;
  readonly physicalCount: number;
  readonly variance: number;
  readonly reservationShortfall: number | null;
  readonly orderNumber: string | null;
  readonly taskNumber: string | null;
  readonly reportedByName: string | null;
  readonly reportedAt: Date;
  /** Whole hours since it was reported — the number that makes a backlog visible. */
  readonly ageHours: number;
}

export async function inventoryExceptions(
  tx: TenantTransaction,
  options: { statuses?: readonly DiscrepancyStatus[]; now?: Date } = {},
): Promise<DiscrepancyRow[]> {
  const now = options.now ?? new Date();
  const statuses = options.statuses ?? (['OPEN', 'UNDER_REVIEW'] as const);

  const rows = await tx.inventoryDiscrepancy.findMany({
    where: { status: { in: [...statuses] } },
    // Oldest first. An exception that has been open longest is the one blocking somebody.
    orderBy: { reportedAt: 'asc' },
    take: 200,
    include: {
      product: { select: { sku: true, name: true, unit: true } },
      salesOrder: { select: { orderNumber: true } },
      warehouseTask: { select: { taskNumber: true } },
    },
  });

  const reporterIds = [
    ...new Set(rows.map((row) => row.reportedById).filter((id): id is string => id !== null)),
  ];
  const reporters = reporterIds.length
    ? await tx.user.findMany({
        where: { id: { in: reporterIds } },
        select: { id: true, fullName: true },
      })
    : [];
  const nameById = new Map(reporters.map((user) => [user.id, user.fullName]));

  return rows.map((row) => ({
    id: row.id,
    discrepancyNumber: row.discrepancyNumber,
    status: row.status as DiscrepancyStatus,
    discrepancyType: row.discrepancyType as DiscrepancyType,
    sku: row.product.sku,
    description: row.product.name,
    unit: row.product.unit,
    systemOnHand: row.systemOnHandQuantity,
    systemReserved: row.systemReservedQuantity,
    physicalCount: row.physicalCountQuantity,
    variance: row.varianceQuantity,
    reservationShortfall: row.reservationShortfall,
    orderNumber: row.salesOrder?.orderNumber ?? null,
    taskNumber: row.warehouseTask?.taskNumber ?? null,
    reportedByName: row.reportedById ? (nameById.get(row.reportedById) ?? null) : null,
    reportedAt: row.reportedAt,
    ageHours: Math.max(
      0,
      Math.floor((now.getTime() - row.reportedAt.getTime()) / 3_600_000),
    ),
  }));
}

export interface AffectedOrderRow {
  readonly reservationId: string;
  readonly salesOrderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly reservedQuantity: number;
  readonly requiredQuantity: number;
  readonly reservedSince: Date;
}

export interface DiscrepancyView extends DiscrepancyRow {
  readonly productId: string;
  readonly reportNote: string | null;
  readonly resolutionType: string | null;
  readonly resolutionNote: string | null;
  readonly resolvedAt: Date | null;
  /** Live figures, so the reviewer sees what is true now as well as what was reported. */
  readonly currentOnHand: number;
  readonly currentReserved: number;
  /**
   * Every order holding stock of this product, unranked.
   *
   * Sorted by order number, which is to say by nothing meaningful. The list deliberately does
   * not suggest who should give way: that is a commercial judgement with a relationship behind
   * it, and a pre-sorted "priority" column would be making the decision while appearing only to
   * display information.
   */
  readonly affectedOrders: readonly AffectedOrderRow[];
}

export async function getDiscrepancy(
  tx: TenantTransaction,
  discrepancyId: string,
  now: Date = new Date(),
): Promise<Result<DiscrepancyView>> {
  if (!isUuid(discrepancyId)) return fail('NOT_FOUND', 'error.notFound');

  const row = await tx.inventoryDiscrepancy.findFirst({
    where: { id: discrepancyId },
    include: {
      product: true,
      salesOrder: { select: { orderNumber: true } },
      warehouseTask: { select: { taskNumber: true } },
    },
  });
  if (!row) return fail('NOT_FOUND', 'error.notFound');

  const reporter = row.reportedById
    ? await tx.user.findFirst({
        where: { id: row.reportedById },
        select: { fullName: true },
      })
    : null;

  const reservations = await tx.stockReservation.findMany({
    where: { productId: row.productId, status: 'ACTIVE' },
    include: {
      salesOrder: { select: { id: true, orderNumber: true, customer: { select: { companyName: true } } } },
      salesOrderItem: { select: { quantity: true } },
    },
  });

  const activeReserved = reservations.reduce((sum, entry) => sum + entry.quantity, 0);

  const affectedOrders: AffectedOrderRow[] = reservations
    .map((entry) => ({
      reservationId: entry.id,
      salesOrderId: entry.salesOrder.id,
      orderNumber: entry.salesOrder.orderNumber,
      customerName: entry.salesOrder.customer.companyName,
      reservedQuantity: entry.quantity,
      requiredQuantity: entry.salesOrderItem.quantity,
      reservedSince: entry.createdAt,
    }))
    .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));

  return ok({
    id: row.id,
    productId: row.productId,
    discrepancyNumber: row.discrepancyNumber,
    status: row.status as DiscrepancyStatus,
    discrepancyType: row.discrepancyType as DiscrepancyType,
    sku: row.product.sku,
    description: row.product.name,
    unit: row.product.unit,
    systemOnHand: row.systemOnHandQuantity,
    systemReserved: row.systemReservedQuantity,
    physicalCount: row.physicalCountQuantity,
    variance: row.varianceQuantity,
    reservationShortfall: row.reservationShortfall,
    orderNumber: row.salesOrder?.orderNumber ?? null,
    taskNumber: row.warehouseTask?.taskNumber ?? null,
    reportedByName: reporter?.fullName ?? null,
    reportedAt: row.reportedAt,
    ageHours: Math.max(0, Math.floor((now.getTime() - row.reportedAt.getTime()) / 3_600_000)),
    reportNote: row.reportNote,
    resolutionType: row.resolutionType,
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    currentOnHand: row.product.availableStock,
    currentReserved: activeReserved,
    affectedOrders,
  });
}

/** Open discrepancies blocking a warehouse task. The gate the handover consults. */
export async function blockingDiscrepancies(
  tx: TenantTransaction,
  warehouseTaskId: string,
): Promise<{ id: string; discrepancyNumber: string; sku: string; variance: number }[]> {
  if (!isUuid(warehouseTaskId)) return [];

  const rows = await tx.inventoryDiscrepancy.findMany({
    where: { warehouseTaskId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
    orderBy: { reportedAt: 'asc' },
    include: { product: { select: { sku: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    discrepancyNumber: row.discrepancyNumber,
    sku: row.product.sku,
    variance: row.varianceQuantity,
  }));
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export interface ReturnRow {
  readonly id: string;
  readonly returnNumber: string;
  readonly status: ReturnStatus;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly deliveryId: string;
  readonly deliveryNumber: string;
  readonly customerName: string;
  readonly returnReason: string;
  readonly lineCount: number;
  readonly createdAt: Date;
}

export async function returnQueue(
  tx: TenantTransaction,
  options: { statuses?: readonly ReturnStatus[] } = {},
): Promise<ReturnRow[]> {
  const rows = await tx.return.findMany({
    where: options.statuses ? { status: { in: [...options.statuses] } } : undefined,
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: {
      items: { select: { id: true } },
      delivery: { select: { deliveryNumber: true, customerNameSnapshot: true } },
      salesOrder: { select: { id: true, orderNumber: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    returnNumber: row.returnNumber,
    status: row.status as ReturnStatus,
    orderId: row.salesOrder.id,
    orderNumber: row.salesOrder.orderNumber,
    deliveryId: row.deliveryId,
    deliveryNumber: row.delivery.deliveryNumber,
    // The delivery's snapshot, not the customer's current row — the same reasoning as Phase 6.
    customerName: row.delivery.customerNameSnapshot,
    returnReason: row.returnReason,
    lineCount: row.items.length,
    createdAt: row.createdAt,
  }));
}

export interface ReturnItemView {
  readonly id: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly quantityDispatched: number;
  readonly quantityExpected: number;
  readonly quantityReceived: number;
  readonly quantityRestockable: number;
  readonly quantityDamaged: number;
  readonly quantityMissing: number;
  readonly disposition: string;
  readonly note: string | null;
}

export interface ReturnView extends ReturnRow {
  readonly note: string | null;
  readonly receivedAt: Date | null;
  readonly inspectedAt: Date | null;
  readonly completedAt: Date | null;
  readonly destination: string;
  readonly items: readonly ReturnItemView[];
  readonly totals: {
    readonly dispatched: number;
    readonly restockable: number;
    readonly damaged: number;
    readonly missing: number;
  };
}

export async function getReturn(
  tx: TenantTransaction,
  returnId: string,
): Promise<Result<ReturnView>> {
  if (!isUuid(returnId)) return fail('NOT_FOUND', 'error.notFound');

  const row = await tx.return.findFirst({
    where: { id: returnId },
    include: {
      items: { orderBy: { createdAt: 'asc' } },
      delivery: true,
      salesOrder: { select: { id: true, orderNumber: true } },
    },
  });
  if (!row) return fail('NOT_FOUND', 'error.notFound');

  const items: ReturnItemView[] = row.items.map((item) => ({
    id: item.id,
    sku: item.skuSnapshot,
    description: item.descriptionSnapshot,
    unit: item.unitSnapshot,
    quantityDispatched: item.quantityDispatched,
    quantityExpected: item.quantityExpected,
    quantityReceived: item.quantityReceived,
    quantityRestockable: item.quantityRestockable,
    quantityDamaged: item.quantityDamaged,
    quantityMissing: item.quantityMissing,
    disposition: item.disposition,
    note: item.note,
  }));

  return ok({
    id: row.id,
    returnNumber: row.returnNumber,
    status: row.status as ReturnStatus,
    orderId: row.salesOrder.id,
    orderNumber: row.salesOrder.orderNumber,
    deliveryId: row.deliveryId,
    deliveryNumber: row.delivery.deliveryNumber,
    customerName: row.delivery.customerNameSnapshot,
    destination: row.delivery.destinationTextSnapshot,
    returnReason: row.returnReason,
    lineCount: row.items.length,
    createdAt: row.createdAt,
    note: row.note,
    receivedAt: row.receivedAt,
    inspectedAt: row.inspectedAt,
    completedAt: row.completedAt,
    items,
    totals: {
      dispatched: items.reduce((sum, item) => sum + item.quantityDispatched, 0),
      restockable: items.reduce((sum, item) => sum + item.quantityRestockable, 0),
      damaged: items.reduce((sum, item) => sum + item.quantityDamaged, 0),
      missing: items.reduce((sum, item) => sum + item.quantityMissing, 0),
    },
  });
}

/** Failed deliveries with no resolution recorded — the post-handoff exceptions list. */
export interface UnresolvedFailureRow {
  readonly id: string;
  readonly deliveryNumber: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly destination: string;
  readonly failureReason: string | null;
  readonly failedAt: Date | null;
  readonly attemptNumber: number;
  /** True when this order was already paid for — the money is a fact, not a suggestion. */
  readonly paymentSettled: boolean;
  readonly paymentType: string;
}

export async function unresolvedFailures(
  tx: TenantTransaction,
): Promise<UnresolvedFailureRow[]> {
  const rows = await tx.delivery.findMany({
    where: { status: 'FAILED', failureResolution: null },
    orderBy: { failedAt: 'asc' },
    take: 200,
    include: {
      salesOrder: {
        select: { id: true, orderNumber: true, paymentStatus: true, paymentType: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    deliveryNumber: row.deliveryNumber,
    orderId: row.salesOrder.id,
    orderNumber: row.salesOrder.orderNumber,
    customerName: row.customerNameSnapshot,
    destination: row.destinationTextSnapshot,
    failureReason: row.failureReason,
    failedAt: row.failedAt,
    attemptNumber: row.attemptNumber,
    paymentSettled: row.salesOrder.paymentStatus === 'PAID',
    paymentType: row.salesOrder.paymentType,
  }));
}

/** Every delivery attempt for an order, oldest first. The retry lineage, readable. */
export async function deliveryAttempts(
  tx: TenantTransaction,
  salesOrderId: string,
): Promise<
  {
    id: string;
    deliveryNumber: string;
    status: string;
    attemptNumber: number;
    retryOfDeliveryId: string | null;
    failureReason: string | null;
    failureResolution: string | null;
  }[]
> {
  if (!isUuid(salesOrderId)) return [];

  const rows = await tx.delivery.findMany({
    where: { salesOrderId },
    orderBy: [{ attemptNumber: 'asc' }, { createdAt: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    deliveryNumber: row.deliveryNumber,
    status: row.status,
    attemptNumber: row.attemptNumber,
    retryOfDeliveryId: row.retryOfDeliveryId,
    failureReason: row.failureReason,
    failureResolution: row.failureResolution,
  }));
}
