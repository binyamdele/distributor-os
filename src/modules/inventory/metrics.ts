import 'server-only';
import type { TenantTransaction } from '@/platform/db';

/**
 * Phase 7 instrumentation.
 *
 * Queries over the operational tables, as in every phase before it. No stored counters, so a
 * figure cannot drift from the rows it claims to summarise.
 *
 * The two numbers a distributor will act on first are the units lost to stock variance and the
 * failed-delivery rate. Variance is money that walked out of the yard without a document.
 * Failures are fuel and a driver's day spent on runs that did not land — and, when the order was
 * already paid for, an obligation somebody has to settle.
 */

function meanHours(pairs: readonly (readonly [Date | null, Date | null])[]): number | null {
  const spans = pairs
    .filter((pair): pair is readonly [Date, Date] => pair[0] !== null && pair[1] !== null)
    .map(([from, to]) => (to.getTime() - from.getTime()) / 3_600_000)
    // A negative span is clock skew or a backdated fixture. Excluded rather than averaged in.
    .filter((hours) => hours >= 0);

  if (spans.length === 0) return null;
  return Math.round((spans.reduce((sum, hours) => sum + hours, 0) / spans.length) * 10) / 10;
}

export interface DiscrepancyMetrics {
  readonly open: number;
  readonly underReview: number;
  readonly resolved: number;
  /** Total units written off through reconciliation. Negative is stock that was not there. */
  readonly netUnitsReconciled: number;
  readonly unitsLostToShortage: number;
  readonly unitsFoundInOverage: number;
  /** How many resolutions were blocked because the yard could not cover its promises. */
  readonly openWithReservationShortfall: number;
  readonly averageHoursToResolve: number | null;
}

export async function discrepancyMetrics(tx: TenantTransaction): Promise<DiscrepancyMetrics> {
  const rows = await tx.inventoryDiscrepancy.findMany({
    select: {
      status: true,
      varianceQuantity: true,
      reservationShortfall: true,
      reportedAt: true,
      resolvedAt: true,
      resolutionType: true,
    },
  });

  const reconciled = rows.filter((row) => row.resolutionType === 'STOCK_RECONCILED');

  return {
    open: rows.filter((row) => row.status === 'OPEN').length,
    underReview: rows.filter((row) => row.status === 'UNDER_REVIEW').length,
    resolved: rows.filter((row) => row.status === 'RESOLVED').length,
    netUnitsReconciled: reconciled.reduce((sum, row) => sum + row.varianceQuantity, 0),
    unitsLostToShortage: reconciled
      .filter((row) => row.varianceQuantity < 0)
      .reduce((sum, row) => sum + Math.abs(row.varianceQuantity), 0),
    unitsFoundInOverage: reconciled
      .filter((row) => row.varianceQuantity > 0)
      .reduce((sum, row) => sum + row.varianceQuantity, 0),
    openWithReservationShortfall: rows.filter(
      (row) => row.status !== 'RESOLVED' && (row.reservationShortfall ?? 0) > 0,
    ).length,
    averageHoursToResolve: meanHours(rows.map((row) => [row.reportedAt, row.resolvedAt] as const)),
  };
}

export interface ExceptionMetrics {
  readonly failuresAwaitingResolution: number;
  readonly retriesCreated: number;
  readonly retriesDelivered: number;
  /** Delivered retries over all resolved retries. Null before any retry has resolved. */
  readonly retrySuccessRate: number | null;
  readonly deliveriesWrittenOff: number;
  readonly returnsInProgress: number;
  readonly returnsCompleted: number;
  readonly unitsReturned: number;
  readonly unitsRestocked: number;
  readonly unitsDamaged: number;
  readonly unitsNotReturned: number;
  readonly averageHoursToResolveFailure: number | null;
}

export async function exceptionMetrics(tx: TenantTransaction): Promise<ExceptionMetrics> {
  const failures = await tx.delivery.findMany({
    where: { status: 'FAILED' },
    select: { failureResolution: true, failedAt: true, resolvedAt: true },
  });

  const retries = await tx.delivery.findMany({
    where: { retryOfDeliveryId: { not: null } },
    select: { status: true },
  });
  const retriesDelivered = retries.filter((row) => row.status === 'DELIVERED').length;
  const retriesResolved = retries.filter(
    (row) => row.status === 'DELIVERED' || row.status === 'FAILED',
  ).length;

  const returns = await tx.return.findMany({
    select: { status: true, items: { select: {
      quantityReceived: true,
      quantityRestockable: true,
      quantityDamaged: true,
      quantityMissing: true,
    } } },
  });

  const completed = returns.filter((row) => row.status === 'COMPLETED');
  const sum = (pick: (item: { quantityReceived: number; quantityRestockable: number; quantityDamaged: number; quantityMissing: number }) => number) =>
    completed.reduce((total, entry) => total + entry.items.reduce((s, item) => s + pick(item), 0), 0);

  return {
    failuresAwaitingResolution: failures.filter((row) => row.failureResolution === null).length,
    retriesCreated: retries.length,
    retriesDelivered,
    retrySuccessRate:
      retriesResolved === 0 ? null : Math.round((retriesDelivered / retriesResolved) * 1000) / 1000,
    deliveriesWrittenOff: failures.filter(
      (row) => row.failureResolution === 'LOST_OR_UNRECOVERABLE',
    ).length,
    returnsInProgress: returns.filter((row) =>
      ['EXPECTED', 'RECEIVED', 'INSPECTED'].includes(row.status),
    ).length,
    returnsCompleted: completed.length,
    unitsReturned: sum((item) => item.quantityReceived),
    unitsRestocked: sum((item) => item.quantityRestockable),
    unitsDamaged: sum((item) => item.quantityDamaged),
    unitsNotReturned: sum((item) => item.quantityMissing),
    averageHoursToResolveFailure: meanHours(
      failures.map((row) => [row.failedAt, row.resolvedAt] as const),
    ),
  };
}

/**
 * Net stock movement by type, over a window.
 *
 * Derived from the ledger, which is the only place every physical change lands. Grouped by type
 * so "what did we lose to variance" and "what did we ship" are separable, which they were not
 * before Phase 7 put them in one table.
 */
export async function movementTotals(
  tx: TenantTransaction,
  since?: Date,
): Promise<{ movementType: string; movements: number; netUnits: number }[]> {
  const rows = await tx.inventoryMovement.groupBy({
    by: ['movementType'],
    where: since ? { createdAt: { gte: since } } : undefined,
    _count: { id: true },
    _sum: { delta: true },
  });

  return rows
    .map((row) => ({
      movementType: row.movementType,
      movements: row._count.id,
      netUnits: row._sum.delta ?? 0,
    }))
    .sort((a, b) => a.movementType.localeCompare(b.movementType));
}
