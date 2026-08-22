import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import { type Period, compareDateToLocalToday } from '@/platform/time/reporting';

/**
 * One definition per number, written down once.
 *
 * The failure this module exists to prevent is mundane and expensive: the dashboard says
 * outstanding receivables are 1.4M, the receivables page says 1.6M, and from that morning
 * onwards the owner believes neither. It happens when two screens each compute the "same" figure
 * from slightly different predicates — one forgetting cancelled orders, one counting submitted
 * payments as received.
 *
 * So every KPI is a function here, and the dashboard, the daily brief and the tests all call the
 * same one. A second implementation of any of these is a defect, whatever it agrees with today.
 *
 * ## Terminology, deliberately operational
 *
 * This is not an accounting ledger and nothing here is revenue recognition. There is no cost
 * basis in the product, so there is no margin, no COGS and no profit. The words used are the
 * ones a distributor uses about their own operation:
 *
 *   quotation value     what was offered
 *   accepted order value  what a customer agreed to buy
 *   confirmed payments  money Finance has verified arrived
 *   outstanding         what is still owed
 *
 * "Sales" alone is never used as a figure, because it could mean any of the first three.
 */

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export interface QuotationActivity {
  readonly created: number;
  readonly createdValueMinor: bigint;
  readonly sent: number;
  readonly accepted: number;
  readonly acceptedValueMinor: bigint;
  readonly rejected: number;
}

/**
 * Quotation activity within a period.
 *
 * **Created** counts by `createdAt`; **accepted** and **rejected** count by the moment the
 * outcome was recorded, not by when the quotation was drafted. A quote written last week and
 * accepted this morning is today's acceptance and last week's creation, and reporting it any
 * other way would make "accepted today" wrong on exactly the days it matters.
 */
export async function quotationActivity(
  tx: TenantTransaction,
  period: Period,
): Promise<QuotationActivity> {
  const created = await tx.quotation.findMany({
    where: { createdAt: { gte: period.start, lt: period.end } },
    select: { grandTotalMinor: true, status: true },
  });

  const sent = await tx.quotation.count({
    where: { sentAt: { gte: period.start, lt: period.end } },
  });

  const accepted = await tx.quotation.findMany({
    where: { acceptedAt: { gte: period.start, lt: period.end } },
    select: { grandTotalMinor: true },
  });

  const rejected = await tx.quotation.count({
    where: { rejectedAt: { gte: period.start, lt: period.end } },
  });

  return {
    created: created.length,
    createdValueMinor: created.reduce((sum, row) => sum + row.grandTotalMinor, 0n),
    sent,
    accepted: accepted.length,
    acceptedValueMinor: accepted.reduce((sum, row) => sum + row.grandTotalMinor, 0n),
    rejected,
  };
}

export interface OrderActivity {
  readonly created: number;
  readonly valueMinor: bigint;
  readonly completed: number;
}

/**
 * Sales orders raised within a period, by grand total.
 *
 * Cancelled orders are excluded from the value: an order that was withdrawn was not a sale, and
 * leaving it in would make the daily figure disagree with the order list a day later. They are
 * excluded from the count for the same reason.
 */
export async function orderActivity(
  tx: TenantTransaction,
  period: Period,
): Promise<OrderActivity> {
  const created = await tx.salesOrder.findMany({
    where: { createdAt: { gte: period.start, lt: period.end }, status: { not: 'CANCELLED' } },
    select: { grandTotalMinor: true },
  });

  const completed = await tx.salesOrder.count({
    where: { completedAt: { gte: period.start, lt: period.end } },
  });

  return {
    created: created.length,
    valueMinor: created.reduce((sum, row) => sum + row.grandTotalMinor, 0n),
    completed,
  };
}

/**
 * Quote acceptance rate: **accepted ÷ (accepted + rejected), both decided within the period**.
 *
 * The denominator is quotations that reached an outcome in the window, not quotations sent in
 * it. Sent-based rates mix cohorts — a quote sent today has not had time to be answered, so it
 * drags the rate down for reasons that have nothing to do with performance, and the number
 * recovers a few days later with no change in behaviour.
 *
 * Returns `null` when nothing was decided. A rate with a zero denominator is not zero percent;
 * it is undefined, and displaying 0% would read as "we lost everything".
 */
export function acceptanceRate(accepted: number, rejected: number): number | null {
  const decided = accepted + rejected;
  if (decided === 0) return null;
  return Math.round((accepted / decided) * 1000) / 1000;
}

export interface LargestAcceptedOrder {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly valueMinor: bigint;
}

/**
 * The largest sales order raised in the period, by grand total.
 *
 * Defined exactly, and named exactly: this is one order on one day, not a "best customer" and
 * not a lifetime value. The customer name is returned for the *dashboard* to render; it is
 * deliberately not part of what any narrative model is given.
 */
export async function largestAcceptedOrder(
  tx: TenantTransaction,
  period: Period,
): Promise<LargestAcceptedOrder | null> {
  const order = await tx.salesOrder.findFirst({
    where: { createdAt: { gte: period.start, lt: period.end }, status: { not: 'CANCELLED' } },
    orderBy: [{ grandTotalMinor: 'desc' }, { orderNumber: 'asc' }],
    select: {
      id: true,
      orderNumber: true,
      grandTotalMinor: true,
      customer: { select: { companyName: true } },
    },
  });
  if (!order) return null;

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerName: order.customer.companyName,
    valueMinor: order.grandTotalMinor,
  };
}

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

/**
 * Confirmed payments within a period.
 *
 * Two rules, both load-bearing:
 *
 *   - **Only `CONFIRMED` counts.** A submitted claim with a photograph attached is a customer's
 *     assertion, not money. Counting it would put figures on an owner's dashboard that Finance
 *     has not verified, which is the exact confusion Phase 5's review gate exists to prevent.
 *   - **By `reviewedAt`, not `paymentDate`.** The window is when the organization confirmed the
 *     money, because that is the event this system witnessed. A slip dated last Tuesday and
 *     confirmed today is today's collection.
 */
export async function confirmedPaymentsIn(
  tx: TenantTransaction,
  period: Period,
): Promise<{ count: number; amountMinor: bigint }> {
  const rows = await tx.payment.findMany({
    where: { status: 'CONFIRMED', reviewedAt: { gte: period.start, lt: period.end } },
    select: { amountConfirmedMinor: true },
  });

  return {
    count: rows.length,
    amountMinor: rows.reduce((sum, row) => sum + (row.amountConfirmedMinor ?? 0n), 0n),
  };
}

/** Payment claims Finance has not yet decided. Not money; a queue. */
export async function paymentsAwaitingReview(tx: TenantTransaction): Promise<number> {
  return tx.payment.count({ where: { status: { in: ['SUBMITTED', 'NEEDS_REVIEW'] } } });
}

export interface ReceivablesTotals {
  readonly outstandingMinor: bigint;
  readonly overdueMinor: bigint;
  readonly dueTodayMinor: bigint;
  readonly dueSoonMinor: bigint;
  readonly overdueCount: number;
  readonly customerCount: number;
}

/**
 * What is still owed, and how much of it is late.
 *
 * Derived from the same rule the receivables screen uses: order grand total minus confirmed
 * payments, over orders that are OPEN or COMPLETED — never CANCELLED, because nothing is owed
 * on an order that did not happen — keeping only positive balances.
 *
 * Overdue is decided by comparing `payment_due_date` as a **calendar date** against the
 * organization-local today. It is a `@db.Date` column with no time and no zone; turning it into
 * an instant and comparing against `now` would make an invoice due today read as overdue for
 * the first three hours of every Ethiopian morning.
 */
export async function receivablesTotals(
  tx: TenantTransaction,
  timezone: string,
  asOf: Date,
  dueSoonDays = 7,
): Promise<ReceivablesTotals> {
  const orders = await tx.salesOrder.findMany({
    where: { status: { in: ['OPEN', 'COMPLETED'] } },
    select: {
      customerId: true,
      grandTotalMinor: true,
      paymentDueDate: true,
      payments: { where: { status: 'CONFIRMED' }, select: { amountConfirmedMinor: true } },
    },
  });

  const totals = {
    outstandingMinor: 0n,
    overdueMinor: 0n,
    dueTodayMinor: 0n,
    dueSoonMinor: 0n,
    overdueCount: 0,
  };
  const customers = new Set<string>();

  for (const order of orders) {
    const confirmed = order.payments.reduce(
      (sum, payment) => sum + (payment.amountConfirmedMinor ?? 0n),
      0n,
    );
    const outstanding = order.grandTotalMinor - confirmed;
    if (outstanding <= 0n) continue;

    totals.outstandingMinor += outstanding;
    customers.add(order.customerId);

    if (!order.paymentDueDate) continue;

    // Whole days from today: negative is late, zero is today, positive is still to come. Three
    // mutually exclusive branches, so overdue, due-today and due-soon never double-count and
    // always sum to no more than the outstanding total.
    const days = compareDateToLocalToday(order.paymentDueDate, timezone, asOf);

    if (days < 0) {
      totals.overdueMinor += outstanding;
      totals.overdueCount += 1;
    } else if (days === 0) {
      totals.dueTodayMinor += outstanding;
    } else if (days <= dueSoonDays) {
      totals.dueSoonMinor += outstanding;
    }
  }

  return { ...totals, customerCount: customers.size };
}

/** Cash orders that have received some confirmed money but not all of it. */
export async function partiallyPaidCashOrders(tx: TenantTransaction): Promise<number> {
  return tx.salesOrder.count({
    where: { paymentType: 'CASH', paymentStatus: 'PARTIALLY_PAID', status: { not: 'CANCELLED' } },
  });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineCounts {
  readonly inquiriesAwaitingReview: number;
  readonly quotationsAwaitingApproval: number;
  readonly quotationsSentAwaitingOutcome: number;
  readonly followUpsDue: number;
  readonly followUpsOverdue: number;
}

/**
 * The pipeline as queues, not as a funnel.
 *
 * A funnel would need one cohort followed through every stage; these are five independent
 * "how many are stuck here" counts taken at one instant, which is what somebody deciding what to
 * do next actually needs. Presenting them as a conversion funnel would imply a relationship
 * between the numbers that does not hold — the inquiries waiting today are not the ancestors of
 * the quotations waiting today.
 */
export async function pipelineCounts(
  tx: TenantTransaction,
  asOf: Date,
): Promise<PipelineCounts> {
  const [inquiries, awaitingApproval, sent, followUps] = await Promise.all([
    tx.inquiry.count({ where: { status: { in: ['RECEIVED', 'NEEDS_REVIEW'] } } }),
    tx.quotation.count({ where: { status: 'PENDING_APPROVAL' } }),
    tx.quotation.count({ where: { status: 'SENT' } }),
    tx.quotationFollowUp.findMany({
      where: { status: 'DUE' },
      select: { dueAt: true },
    }),
  ]);

  return {
    inquiriesAwaitingReview: inquiries,
    quotationsAwaitingApproval: awaitingApproval,
    quotationsSentAwaitingOutcome: sent,
    followUpsDue: followUps.length,
    followUpsOverdue: followUps.filter((row) => row.dueAt.getTime() < asOf.getTime()).length,
  };
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

export interface FulfilmentCounts {
  readonly ordersAwaitingWarehouse: number;
  readonly tasksPending: number;
  readonly tasksInProgress: number;
  readonly tasksPrepared: number;
  readonly deliveriesPending: number;
  readonly deliveriesDispatched: number;
  readonly failedDeliveriesOpen: number;
  readonly ordersCompletedToday: number;
}

export async function fulfilmentCounts(
  tx: TenantTransaction,
  today: Period,
): Promise<FulfilmentCounts> {
  const [awaiting, tasks, deliveries, failures, completed] = await Promise.all([
    tx.salesOrder.count({
      where: {
        status: 'OPEN',
        fulfillmentStatus: 'READY',
        warehouseTasks: { none: { status: { not: 'CANCELLED' } } },
      },
    }),
    tx.warehouseTask.groupBy({
      by: ['status'],
      where: { status: { in: ['PENDING', 'IN_PROGRESS', 'PREPARED'] } },
      _count: { id: true },
    }),
    tx.delivery.groupBy({
      by: ['status'],
      where: { status: { in: ['PENDING', 'ASSIGNED', 'DISPATCHED'] } },
      _count: { id: true },
    }),
    tx.delivery.count({ where: { status: 'FAILED', failureResolution: null } }),
    tx.salesOrder.count({ where: { completedAt: { gte: today.start, lt: today.end } } }),
  ]);

  const taskCount = (status: string) =>
    tasks.find((row) => row.status === status)?._count.id ?? 0;
  const deliveryCount = (status: string) =>
    deliveries.find((row) => row.status === status)?._count.id ?? 0;

  return {
    ordersAwaitingWarehouse: awaiting,
    tasksPending: taskCount('PENDING'),
    tasksInProgress: taskCount('IN_PROGRESS'),
    tasksPrepared: taskCount('PREPARED'),
    // Assigned and pending are one queue to an owner: nothing has left the yard either way.
    deliveriesPending: deliveryCount('PENDING') + deliveryCount('ASSIGNED'),
    deliveriesDispatched: deliveryCount('DISPATCHED'),
    failedDeliveriesOpen: failures,
    ordersCompletedToday: completed,
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryCounts {
  readonly lowStockProducts: number;
  readonly openDiscrepancies: number;
  readonly reservationShortfalls: number;
  readonly returnsAwaitingProcessing: number;
  readonly damagedUnitsReturned: number;
  readonly unitsNotReturned: number;
}

/**
 * Inventory exposure.
 *
 * Low stock uses Phase 1's rule unchanged — `freeStock = available − reserved`, low when
 * `freeStock <= reorderThreshold` and the threshold is set. Reusing it means Phase 7's
 * consumption, reconciliation and restock all flow through automatically: they move
 * `available_stock` and `reserved_stock`, and this reads the result rather than re-deriving it
 * from movements, which could disagree.
 */
export async function inventoryCounts(tx: TenantTransaction): Promise<InventoryCounts> {
  const [products, discrepancies, returnsOpen, completedReturns] = await Promise.all([
    tx.product.findMany({
      where: { active: true },
      select: { availableStock: true, reservedStock: true, reorderThreshold: true },
    }),
    tx.inventoryDiscrepancy.findMany({
      where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      select: { reservationShortfall: true },
    }),
    tx.return.count({ where: { status: { in: ['EXPECTED', 'RECEIVED', 'INSPECTED'] } } }),
    tx.returnItem.findMany({
      where: { return: { status: 'COMPLETED' } },
      select: { quantityDamaged: true, quantityMissing: true },
    }),
  ]);

  return {
    lowStockProducts: products.filter(
      (product) =>
        product.reorderThreshold > 0 &&
        product.availableStock - product.reservedStock <= product.reorderThreshold,
    ).length,
    openDiscrepancies: discrepancies.length,
    reservationShortfalls: discrepancies.filter((row) => (row.reservationShortfall ?? 0) > 0)
      .length,
    returnsAwaitingProcessing: returnsOpen,
    damagedUnitsReturned: completedReturns.reduce((sum, row) => sum + row.quantityDamaged, 0),
    unitsNotReturned: completedReturns.reduce((sum, row) => sum + row.quantityMissing, 0),
  };
}
