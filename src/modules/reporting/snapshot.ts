import 'server-only';
import { createHash } from 'node:crypto';
import type { TenantTransaction } from '@/platform/db';
import { type Role, can } from '@/platform/rbac';
import {
  lastLocalDays,
  localDateKey,
  localDay,
  localDaysIn,
  precedingLocalDays,
  previousLocalDay,
} from '@/platform/time/reporting';
import {
  type AttentionItem,
  type AttentionScope,
  attentionQueue,
} from './attention';
import {
  acceptanceRate,
  confirmedPaymentsIn,
  fulfilmentCounts,
  inventoryCounts,
  largestAcceptedOrder,
  orderActivity,
  partiallyPaidCashOrders,
  paymentsAwaitingReview,
  pipelineCounts,
  quotationActivity,
  receivablesTotals,
} from './definitions';
import { type MoneyTrend, type Trend, compare, compareMoney } from './trends';

/**
 * The dashboard read model.
 *
 * One function assembles the whole page, and the daily brief reads the same object. That is the
 * point: a brief computed from a second set of queries would eventually disagree with the screen
 * it sits on, and the owner would have no way to know which was right.
 *
 * ## Scoping is part of the model, not the template
 *
 * A section the caller may not read comes back as `null` rather than as a number the component
 * declines to render. Aggregation is not a side door around RBAC — a warehouse user must not
 * learn what is overdue by reading a total of it — so the permission check happens where the
 * query is issued, and the section is simply not computed.
 */

export interface SalesSection {
  readonly quotationsCreated: number;
  readonly quotationValueTodayMinor: bigint;
  readonly quotationsSent: number;
  readonly quotationsAccepted: number;
  readonly acceptedValueTodayMinor: bigint;
  readonly quotationsRejected: number;
  /** Accepted ÷ (accepted + rejected), decided today. Null when nothing was decided. */
  readonly acceptanceRate: number | null;
  readonly ordersCreated: number;
  readonly orderValueTodayMinor: bigint;
  readonly largestOrder: {
    readonly orderId: string;
    readonly orderNumber: string;
    readonly customerName: string;
    readonly valueMinor: bigint;
  } | null;
}

export interface CashSection {
  readonly paymentsConfirmedToday: number;
  readonly paymentsConfirmedTodayMinor: bigint;
  readonly outstandingReceivablesMinor: bigint;
  readonly overdueReceivablesMinor: bigint;
  readonly overdueCount: number;
  readonly dueTodayMinor: bigint;
  readonly dueSoonMinor: bigint;
  readonly debtorCount: number;
  readonly partiallyPaidCashOrders: number;
  readonly paymentsAwaitingReview: number;
}

export interface PipelineSection {
  readonly inquiriesAwaitingReview: number;
  readonly quotationsAwaitingApproval: number;
  readonly quotationsSentAwaitingOutcome: number;
  readonly followUpsDue: number;
  readonly followUpsOverdue: number;
}

export interface OperationsSection {
  readonly ordersAwaitingWarehouse: number;
  readonly warehousePending: number;
  readonly warehouseInProgress: number;
  readonly warehousePrepared: number;
  readonly deliveriesPending: number;
  readonly deliveriesDispatched: number;
  readonly failedDeliveriesOpen: number;
  readonly ordersCompletedToday: number;
}

export interface InventorySection {
  readonly lowStockProducts: number;
  readonly openDiscrepancies: number;
  readonly reservationShortfalls: number;
  readonly returnsAwaitingProcessing: number;
  readonly damagedUnitsReturned: number;
  readonly unitsNotReturned: number;
}

export interface TrendSection {
  readonly orderValue: MoneyTrend;
  readonly confirmedPayments: MoneyTrend;
  readonly ordersCreated: Trend;
  readonly quotationsAccepted: Trend;
}

/** One day of the seven-day series. Value is minor units. */
export interface SeriesPoint {
  readonly dateKey: string;
  readonly orderValueMinor: bigint;
  readonly confirmedPaymentsMinor: bigint;
}

export interface DashboardSnapshot {
  readonly asOf: Date;
  readonly timezone: string;
  readonly currency: string;
  /** The organization-local calendar date this snapshot describes. */
  readonly dateKey: string;
  readonly sales: SalesSection | null;
  readonly cash: CashSection | null;
  readonly pipeline: PipelineSection | null;
  readonly operations: OperationsSection | null;
  readonly inventory: InventorySection | null;
  readonly trends: TrendSection | null;
  readonly series: readonly SeriesPoint[];
  readonly attention: readonly AttentionItem[];
}

/**
 * What a role may see, derived from the permissions that guard the underlying screens.
 *
 * Deliberately expressed in terms of existing permissions rather than a new
 * `read:dashboard-financials`. If a role may open the receivables page, the same figures in
 * aggregate are not a new disclosure; if it may not, the aggregate is exactly the disclosure
 * that must not happen.
 */
export function dashboardScopeFor(role: Role): AttentionScope {
  return {
    money: can(role, 'read:receivables') || can(role, 'read:payment'),
    sales: can(role, 'read:quotation'),
    operations: can(role, 'read:warehouse-task') || can(role, 'read:delivery'),
  };
}

export interface SnapshotOptions {
  readonly timezone: string;
  readonly currency: string;
  readonly role: Role;
  readonly asOf?: Date;
  /** Cap on the attention queue. The dashboard shows a page; the brief counts them all. */
  readonly attentionLimit?: number;
}

/**
 * Builds the whole dashboard in one pass.
 *
 * Sections run concurrently rather than sequentially, and each is a handful of aggregate queries
 * against indexed predicates — not a query per card and never a query per row. The alternative,
 * components each fetching their own figure, is how a dashboard becomes forty round trips and
 * how two cards start disagreeing.
 */
export async function getDashboardSnapshot(
  tx: TenantTransaction,
  options: SnapshotOptions,
): Promise<DashboardSnapshot> {
  const asOf = options.asOf ?? new Date();
  const { timezone, currency, role } = options;
  const scope = dashboardScopeFor(role);

  const today = localDay(timezone, asOf);
  const yesterday = previousLocalDay(timezone, asOf);
  const lastSeven = lastLocalDays(timezone, asOf, 7);
  const previousSeven = precedingLocalDays(timezone, asOf, 7);

  const [
    quotesToday,
    ordersToday,
    largest,
    paymentsToday,
    receivables,
    partialCash,
    awaitingReview,
    pipeline,
    fulfilment,
    inventory,
    ordersYesterday,
    quotesYesterday,
    ordersLastSeven,
    ordersPreviousSeven,
    paymentsLastSeven,
    paymentsPreviousSeven,
    attention,
  ] = await Promise.all([
    scope.sales ? quotationActivity(tx, today) : null,
    scope.sales ? orderActivity(tx, today) : null,
    scope.sales && scope.money ? largestAcceptedOrder(tx, today) : null,
    scope.money ? confirmedPaymentsIn(tx, today) : null,
    scope.money ? receivablesTotals(tx, timezone, asOf) : null,
    scope.money ? partiallyPaidCashOrders(tx) : null,
    scope.money ? paymentsAwaitingReview(tx) : null,
    scope.sales ? pipelineCounts(tx, asOf) : null,
    scope.operations ? fulfilmentCounts(tx, today) : null,
    scope.operations ? inventoryCounts(tx) : null,
    scope.sales ? orderActivity(tx, yesterday) : null,
    scope.sales ? quotationActivity(tx, yesterday) : null,
    scope.sales ? orderActivity(tx, lastSeven) : null,
    scope.sales ? orderActivity(tx, previousSeven) : null,
    scope.money ? confirmedPaymentsIn(tx, lastSeven) : null,
    scope.money ? confirmedPaymentsIn(tx, previousSeven) : null,
    attentionQueue(tx, { timezone, asOf, scope, limit: options.attentionLimit }),
  ]);

  const series = await buildSeries(tx, timezone, asOf, scope);

  const sales: SalesSection | null =
    quotesToday && ordersToday
      ? {
          quotationsCreated: quotesToday.created,
          quotationValueTodayMinor: quotesToday.createdValueMinor,
          quotationsSent: quotesToday.sent,
          quotationsAccepted: quotesToday.accepted,
          acceptedValueTodayMinor: quotesToday.acceptedValueMinor,
          quotationsRejected: quotesToday.rejected,
          acceptanceRate: acceptanceRate(quotesToday.accepted, quotesToday.rejected),
          ordersCreated: ordersToday.created,
          orderValueTodayMinor: ordersToday.valueMinor,
          largestOrder: largest,
        }
      : null;

  const cash: CashSection | null =
    paymentsToday && receivables
      ? {
          paymentsConfirmedToday: paymentsToday.count,
          paymentsConfirmedTodayMinor: paymentsToday.amountMinor,
          outstandingReceivablesMinor: receivables.outstandingMinor,
          overdueReceivablesMinor: receivables.overdueMinor,
          overdueCount: receivables.overdueCount,
          dueTodayMinor: receivables.dueTodayMinor,
          dueSoonMinor: receivables.dueSoonMinor,
          debtorCount: receivables.customerCount,
          partiallyPaidCashOrders: partialCash ?? 0,
          paymentsAwaitingReview: awaitingReview ?? 0,
        }
      : null;

  const operations: OperationsSection | null = fulfilment
    ? {
        ordersAwaitingWarehouse: fulfilment.ordersAwaitingWarehouse,
        warehousePending: fulfilment.tasksPending,
        warehouseInProgress: fulfilment.tasksInProgress,
        warehousePrepared: fulfilment.tasksPrepared,
        deliveriesPending: fulfilment.deliveriesPending,
        deliveriesDispatched: fulfilment.deliveriesDispatched,
        failedDeliveriesOpen: fulfilment.failedDeliveriesOpen,
        ordersCompletedToday: fulfilment.ordersCompletedToday,
      }
    : null;

  // Trends need both halves. A role that sees neither sales nor money gets no trend section
  // rather than a section of zeroes that would read as a real decline.
  const trends: TrendSection | null =
    ordersLastSeven && ordersPreviousSeven && ordersToday && ordersYesterday
      ? {
          orderValue: compareMoney(ordersLastSeven.valueMinor, ordersPreviousSeven.valueMinor),
          confirmedPayments: compareMoney(
            paymentsLastSeven?.amountMinor ?? 0n,
            paymentsPreviousSeven?.amountMinor ?? 0n,
          ),
          ordersCreated: compare(ordersToday.created, ordersYesterday.created),
          quotationsAccepted: compare(
            quotesToday?.accepted ?? 0,
            quotesYesterday?.accepted ?? 0,
          ),
        }
      : null;

  return {
    asOf,
    timezone,
    currency,
    dateKey: localDateKey(asOf, timezone),
    sales,
    cash,
    pipeline: pipeline ?? null,
    operations,
    inventory: inventory ?? null,
    trends,
    series,
    attention,
  };
}

/**
 * Seven days of order value and confirmed payments, oldest first.
 *
 * Two grouped queries over the whole window rather than fourteen day-by-day ones — the shape
 * that turns a small chart into a per-card table scan. The days are then filled in from the
 * result, so a day with no activity is a zero rather than a gap, and the chart does not imply
 * the business was closed.
 */
async function buildSeries(
  tx: TenantTransaction,
  timezone: string,
  asOf: Date,
  scope: AttentionScope,
): Promise<SeriesPoint[]> {
  const days = localDaysIn(timezone, asOf, 7);
  if (days.length === 0) return [];

  const window = { start: days[0]!.start, end: days[days.length - 1]!.end };

  const [orders, payments] = await Promise.all([
    scope.sales
      ? tx.salesOrder.findMany({
          where: {
            createdAt: { gte: window.start, lt: window.end },
            status: { not: 'CANCELLED' },
          },
          select: { createdAt: true, grandTotalMinor: true },
        })
      : Promise.resolve([]),
    scope.money
      ? tx.payment.findMany({
          where: {
            status: 'CONFIRMED',
            reviewedAt: { gte: window.start, lt: window.end },
          },
          select: { reviewedAt: true, amountConfirmedMinor: true },
        })
      : Promise.resolve([]),
  ]);

  return days.map((day) => ({
    dateKey: localDateKey(day.start, timezone),
    orderValueMinor: orders
      .filter((row) => row.createdAt >= day.start && row.createdAt < day.end)
      .reduce((sum, row) => sum + row.grandTotalMinor, 0n),
    confirmedPaymentsMinor: payments
      .filter((row) => row.reviewedAt !== null && row.reviewedAt >= day.start && row.reviewedAt < day.end)
      .reduce((sum, row) => sum + (row.amountConfirmedMinor ?? 0n), 0n),
  }));
}

/**
 * A stable hash of the figures a narrative was written from.
 *
 * The same governance idea as the quotation approval payload and the payment confirmation
 * payload: a narrative is bound to the exact numbers it describes, so a stored summary can never
 * be silently re-attached to a different day's figures. Volatile fields — the instant the
 * snapshot was taken, the attention items' ages — are excluded, because they change every second
 * and would make two identical business positions hash differently.
 */
export function snapshotHash(snapshot: DashboardSnapshot): string {
  const stable = {
    dateKey: snapshot.dateKey,
    timezone: snapshot.timezone,
    currency: snapshot.currency,
    sales: snapshot.sales
      ? { ...snapshot.sales, largestOrder: snapshot.sales.largestOrder?.orderNumber ?? null }
      : null,
    cash: snapshot.cash,
    pipeline: snapshot.pipeline,
    operations: snapshot.operations,
    inventory: snapshot.inventory,
    attention: snapshot.attention.map((item) => `${item.kind}:${item.reference}:${item.severity}`),
  };

  return createHash('sha256')
    .update(JSON.stringify(stable, (_key, value) => (typeof value === 'bigint' ? `${value}n` : value)))
    .digest('hex');
}
