import 'server-only';
import type { TenantTransaction } from '@/platform/db';

/**
 * Phase 4 instrumentation.
 *
 * Queries over the operational tables, as in Phase 2. The questions worth answering here are
 * about the sales funnel and about how often the yard lets it down:
 *
 *   - how many quotations are waiting to be chased, and are they being chased
 *   - what proportion of sent quotations convert, and what the rest say when they do not
 *   - how often an accepted order cannot be raised because the stock has gone
 *
 * That last one is the number a distributor will act on first. A conversion that fails at the
 * reservation step is a sale already won and then lost to inventory, which is a different
 * problem from a quotation that was never accepted.
 */

export interface FollowUpMetrics {
  readonly openFollowUps: number;
  readonly overdueFollowUps: number;
  readonly completedFollowUps: number;
  /** Completed / (completed + open). Null when nothing has been scheduled. */
  readonly completionRate: number | null;
  readonly outcomeDistribution: Readonly<Record<string, number>>;
  /** Mean days between a follow-up falling due and being completed. */
  readonly averageDaysToComplete: number | null;
}

export interface ConversionMetrics {
  readonly sent: number;
  readonly accepted: number;
  readonly rejected: number;
  /** Accepted / (accepted + rejected + still sent). */
  readonly acceptanceRate: number | null;
  readonly rejectionRate: number | null;
  readonly rejectionReasons: Readonly<Record<string, number>>;
  /** Mean days from sending to acceptance. */
  readonly averageDaysToAccept: number | null;
  readonly ordersCreated: number;
  readonly ordersCancelled: number;
  /** Accepted quotations with no active order — usually a stock refusal. */
  readonly acceptedWithoutOrder: number;
  readonly stockRefusals: number;
}

function meanDays(pairs: readonly [Date, Date][]): number | null {
  if (pairs.length === 0) return null;
  const total = pairs.reduce(
    (acc, [from, to]) => acc + (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000),
    0,
  );
  return total / pairs.length;
}

export async function followUpMetrics(
  tx: TenantTransaction,
  now: Date = new Date(),
): Promise<FollowUpMetrics> {
  const [open, overdue, completed, outcomes, completedRows] = await Promise.all([
    tx.quotationFollowUp.count({ where: { status: { in: ['DUE', 'SNOOZED'] } } }),
    tx.quotationFollowUp.count({
      where: { status: { in: ['DUE', 'SNOOZED'] }, dueAt: { lt: now } },
    }),
    tx.quotationFollowUp.count({ where: { status: 'COMPLETED' } }),
    tx.quotationFollowUp.groupBy({
      by: ['outcome'],
      where: { status: 'COMPLETED' },
      _count: { _all: true },
    }),
    tx.quotationFollowUp.findMany({
      where: { status: 'COMPLETED', completedAt: { not: null } },
      select: { dueAt: true, completedAt: true },
      take: 500,
    }),
  ]);

  const scheduled = open + completed;

  return {
    openFollowUps: open,
    overdueFollowUps: overdue,
    completedFollowUps: completed,
    completionRate: scheduled === 0 ? null : completed / scheduled,
    outcomeDistribution: Object.fromEntries(
      outcomes.map((row) => [row.outcome ?? 'UNRECORDED', row._count._all]),
    ),
    averageDaysToComplete: meanDays(
      completedRows.map((row) => [row.dueAt, row.completedAt!] as [Date, Date]),
    ),
  };
}

export async function conversionMetrics(tx: TenantTransaction): Promise<ConversionMetrics> {
  const [byStatus, reasons, acceptedRows, orders, cancelled, stockRefusals] = await Promise.all([
    tx.quotation.groupBy({ by: ['status'], _count: { _all: true } }),
    tx.quotation.groupBy({
      by: ['rejectionReason'],
      where: { status: 'REJECTED' },
      _count: { _all: true },
    }),
    tx.quotation.findMany({
      where: { status: 'ACCEPTED', sentAt: { not: null }, acceptedAt: { not: null } },
      select: { id: true, sentAt: true, acceptedAt: true },
      take: 500,
    }),
    tx.salesOrder.count(),
    tx.salesOrder.count({ where: { status: 'CANCELLED' } }),
    tx.auditEvent.count({ where: { action: 'order.creation_refused_insufficient_stock' } }),
  ]);

  const counts = new Map(byStatus.map((row) => [row.status as string, row._count._all]));
  const at = (status: string): number => counts.get(status) ?? 0;

  const sent = at('SENT');
  const accepted = at('ACCEPTED');
  const rejected = at('REJECTED');
  const answered = sent + accepted + rejected;

  const acceptedIds = acceptedRows.map((row) => row.id);
  const ordersForAccepted = await tx.salesOrder.count({
    where: { quotationId: { in: acceptedIds }, status: { not: 'CANCELLED' } },
  });

  return {
    sent,
    accepted,
    rejected,
    acceptanceRate: answered === 0 ? null : accepted / answered,
    rejectionRate: answered === 0 ? null : rejected / answered,
    rejectionReasons: Object.fromEntries(
      reasons.map((row) => [row.rejectionReason ?? 'UNRECORDED', row._count._all]),
    ),
    averageDaysToAccept: meanDays(
      acceptedRows.map((row) => [row.sentAt!, row.acceptedAt!] as [Date, Date]),
    ),
    ordersCreated: orders,
    ordersCancelled: cancelled,
    acceptedWithoutOrder: Math.max(0, acceptedRows.length - ordersForAccepted),
    stockRefusals,
  };
}

export interface ReservedStockRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly unit: string;
  readonly availableStock: number;
  readonly reservedStock: number;
  readonly freeStock: number;
}

/** Reserved stock by product, for the warehouse and buying conversations. */
export async function reservedStockByProduct(tx: TenantTransaction): Promise<ReservedStockRow[]> {
  const products = await tx.product.findMany({
    where: { reservedStock: { gt: 0 } },
    orderBy: { name: 'asc' },
  });

  return products.map((product) => ({
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
    availableStock: product.availableStock,
    reservedStock: product.reservedStock,
    freeStock: product.availableStock - product.reservedStock,
  }));
}
