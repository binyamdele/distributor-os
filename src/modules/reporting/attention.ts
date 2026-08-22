import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import { compareDateToLocalToday } from '@/platform/time/reporting';

/**
 * The unified "needs attention" queue.
 *
 * Probably the most useful thing on the dashboard, and the place where it would be easiest to do
 * something clever and wrong. So:
 *
 *   - **Membership is a query, not a judgement.** Every item here is a row in a specific state
 *     that a specific person can act on. Nothing is included because it "seems important".
 *   - **Severity comes from written rules**, enumerated below and unit-tested. There is no
 *     score, no weighting and no model. An owner who cannot predict why something is at the top
 *     of their list will stop reading the list, and a list nobody reads is worse than none.
 *   - **No customer value anywhere.** Ordering a queue by who spends most is a policy decision
 *     with a customer on the other end of it, and it is not one a dashboard should make quietly.
 *   - **AI never chooses what appears here, or in what order.** It may read the finished list.
 *
 * ## The severity rules, in full
 *
 * CRITICAL — money is at risk or an accepted commitment cannot be met:
 *   - a reservation shortfall, meaning an accepted order can no longer be filled in full
 *   - a delivery written off as lost on an order that has already been paid for
 *   - an inventory discrepancy that is blocking a warehouse handoff
 *
 * HIGH — somebody is waiting, and the wait is already costing something:
 *   - an overdue receivable
 *   - a payment claim unreviewed for longer than a working day
 *   - a failed delivery with no resolution recorded
 *   - a follow-up past its due time
 *   - a return that has been sitting uninspected
 *
 * NORMAL — needs doing, nothing is bleeding:
 *   - a quotation waiting for approval
 *   - an inventory discrepancy not blocking anything
 *   - a receivable due today
 *   - a warehouse task that has been open unusually long
 */

export const ATTENTION_SEVERITIES = ['CRITICAL', 'HIGH', 'NORMAL'] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

export const ATTENTION_KINDS = [
  'RESERVATION_SHORTFALL',
  'PAID_ORDER_GOODS_LOST',
  'DISCREPANCY_BLOCKING_HANDOFF',
  'OVERDUE_RECEIVABLE',
  'PAYMENT_AWAITING_REVIEW',
  'FAILED_DELIVERY_UNRESOLVED',
  'FOLLOW_UP_OVERDUE',
  'RETURN_AWAITING_INSPECTION',
  'QUOTATION_AWAITING_APPROVAL',
  'INVENTORY_DISCREPANCY',
  'RECEIVABLE_DUE_TODAY',
  'WAREHOUSE_TASK_STALE',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly severity: AttentionSeverity;
  /** The entity this is about, for a stable React key and for tests. */
  readonly entityId: string;
  /** The human reference: SO-000042, IR-000007, Q-000113. */
  readonly reference: string;
  /** One line, already complete. No template assembly in the component. */
  readonly title: string;
  /** Whole hours since the thing started waiting. */
  readonly ageHours: number;
  /** Present only where money is genuinely at stake. Never a proxy for importance. */
  readonly amountMinor: bigint | null;
  /** Where to go and do something about it. */
  readonly href: string;
}

/** Hours a payment claim may sit before it is treated as a wait rather than a queue. */
const PAYMENT_REVIEW_HOURS = 24;
/** Hours a warehouse task may be open before it is worth asking about. */
const STALE_TASK_HOURS = 48;
/** Hours a received return may sit uninspected before it is worth asking about. */
const STALE_RETURN_HOURS = 24;

const SEVERITY_ORDER: Readonly<Record<AttentionSeverity, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
};

/**
 * Deterministic ordering: severity, then age, then reference.
 *
 * Age rather than amount as the second key, on purpose. Sorting by money would put a large new
 * problem above a small old one, and the small old one is the one being forgotten.
 */
export function prioritiseAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    if (SEVERITY_ORDER[a.severity] !== SEVERITY_ORDER[b.severity]) {
      return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    }
    if (a.ageHours !== b.ageHours) return b.ageHours - a.ageHours;
    return a.reference.localeCompare(b.reference);
  });
}

function hoursSince(from: Date | null, asOf: Date): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((asOf.getTime() - from.getTime()) / 3_600_000));
}

export interface AttentionScope {
  /** Include receivables, payment reviews and money amounts. */
  readonly money: boolean;
  /** Include quotations, follow-ups and the sales pipeline. */
  readonly sales: boolean;
  /** Include warehouse, delivery, discrepancy and return items. */
  readonly operations: boolean;
}

/**
 * Builds the queue, including only the sections the caller is permitted to see.
 *
 * Scoping happens here rather than in the page, because an aggregate is still the underlying
 * data. A warehouse user must not learn what is overdue by reading a count of it — see
 * `dashboardScopeFor` in the snapshot module, which derives this from the role's permissions.
 */
export async function attentionQueue(
  tx: TenantTransaction,
  options: { timezone: string; asOf: Date; scope: AttentionScope; limit?: number },
): Promise<AttentionItem[]> {
  const { timezone, asOf, scope } = options;
  const items: AttentionItem[] = [];

  // --- operations: discrepancies, deliveries, returns, warehouse -----------
  if (scope.operations) {
    const discrepancies = await tx.inventoryDiscrepancy.findMany({
      where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      select: {
        id: true,
        discrepancyNumber: true,
        varianceQuantity: true,
        reservationShortfall: true,
        reportedAt: true,
        warehouseTaskId: true,
        product: { select: { sku: true, name: true } },
      },
    });

    for (const row of discrepancies) {
      const shortfall = row.reservationShortfall ?? 0;
      const blocking = row.warehouseTaskId !== null;

      items.push({
        kind: shortfall > 0
          ? 'RESERVATION_SHORTFALL'
          : blocking
            ? 'DISCREPANCY_BLOCKING_HANDOFF'
            : 'INVENTORY_DISCREPANCY',
        // A shortfall means an accepted order cannot be filled — a promise already made that
        // cannot be kept. Blocking a handoff stops goods that are otherwise ready to go.
        severity: shortfall > 0 ? 'CRITICAL' : blocking ? 'CRITICAL' : 'NORMAL',
        entityId: row.id,
        reference: row.discrepancyNumber,
        title:
          shortfall > 0
            ? `${row.product.name} (${row.product.sku}): ${shortfall} more is promised than counted`
            : `${row.product.name} (${row.product.sku}): counted ${row.varianceQuantity > 0 ? '+' : ''}${row.varianceQuantity} against the system`,
        ageHours: hoursSince(row.reportedAt, asOf),
        amountMinor: null,
        href: `/exceptions/${row.id}`,
      });
    }

    const failures = await tx.delivery.findMany({
      where: { status: 'FAILED', failureResolution: null },
      select: {
        id: true,
        deliveryNumber: true,
        failedAt: true,
        customerNameSnapshot: true,
        salesOrder: {
          select: { orderNumber: true, paymentStatus: true, grandTotalMinor: true },
        },
      },
    });

    for (const row of failures) {
      items.push({
        kind: 'FAILED_DELIVERY_UNRESOLVED',
        severity: 'HIGH',
        entityId: row.id,
        reference: row.deliveryNumber,
        title: `${row.customerNameSnapshot}: delivery failed on ${row.salesOrder.orderNumber} and has no resolution`,
        ageHours: hoursSince(row.failedAt, asOf),
        // The amount only when the money already arrived, because that is what turns an
        // operational failure into an obligation.
        amountMinor:
          scope.money && row.salesOrder.paymentStatus === 'PAID'
            ? row.salesOrder.grandTotalMinor
            : null,
        href: `/deliveries/${row.id}`,
      });
    }

    const lost = await tx.delivery.findMany({
      where: { status: 'FAILED', failureResolution: 'LOST_OR_UNRECOVERABLE' },
      select: {
        id: true,
        deliveryNumber: true,
        resolvedAt: true,
        customerNameSnapshot: true,
        salesOrder: {
          select: { id: true, orderNumber: true, paymentStatus: true, grandTotalMinor: true },
        },
      },
    });

    for (const row of lost) {
      // Only the paid case appears. Goods lost on an unpaid credit order is a bad day; goods
      // lost on an order the customer has already paid for is an obligation with a person on
      // the other end of it, and nothing else in the product will resolve it.
      if (row.salesOrder.paymentStatus !== 'PAID') continue;

      items.push({
        kind: 'PAID_ORDER_GOODS_LOST',
        severity: 'CRITICAL',
        entityId: row.id,
        reference: row.deliveryNumber,
        title: `${row.customerNameSnapshot} paid for ${row.salesOrder.orderNumber} and the goods were lost`,
        ageHours: hoursSince(row.resolvedAt, asOf),
        amountMinor: scope.money ? row.salesOrder.grandTotalMinor : null,
        href: `/orders/${row.salesOrder.id}`,
      });
    }

    const returns = await tx.return.findMany({
      where: { status: { in: ['EXPECTED', 'RECEIVED'] } },
      select: {
        id: true,
        returnNumber: true,
        status: true,
        createdAt: true,
        receivedAt: true,
        delivery: { select: { customerNameSnapshot: true } },
      },
    });

    for (const row of returns) {
      const waitingSince = row.status === 'RECEIVED' ? row.receivedAt : row.createdAt;
      const ageHours = hoursSince(waitingSince, asOf);
      if (row.status === 'RECEIVED' && ageHours < STALE_RETURN_HOURS) continue;

      items.push({
        kind: 'RETURN_AWAITING_INSPECTION',
        severity: row.status === 'RECEIVED' ? 'HIGH' : 'NORMAL',
        entityId: row.id,
        reference: row.returnNumber,
        title:
          row.status === 'RECEIVED'
            ? `${row.delivery.customerNameSnapshot}: returned goods are in the yard and uninspected`
            : `${row.delivery.customerNameSnapshot}: goods are expected back`,
        ageHours,
        amountMinor: null,
        href: `/returns/${row.id}`,
      });
    }

    const staleTasks = await tx.warehouseTask.findMany({
      where: { status: { in: ['PENDING', 'IN_PROGRESS', 'PREPARED'] } },
      select: {
        id: true,
        taskNumber: true,
        createdAt: true,
        salesOrder: { select: { orderNumber: true, customer: { select: { companyName: true } } } },
      },
    });

    for (const row of staleTasks) {
      const ageHours = hoursSince(row.createdAt, asOf);
      if (ageHours < STALE_TASK_HOURS) continue;

      items.push({
        kind: 'WAREHOUSE_TASK_STALE',
        severity: 'NORMAL',
        entityId: row.id,
        reference: row.taskNumber,
        title: `${row.salesOrder.customer.companyName}: ${row.salesOrder.orderNumber} has been waiting in the warehouse`,
        ageHours,
        amountMinor: null,
        href: `/warehouse/${row.id}`,
      });
    }
  }

  // --- money: receivables and the payment queue ----------------------------
  if (scope.money) {
    const orders = await tx.salesOrder.findMany({
      where: { status: { in: ['OPEN', 'COMPLETED'] }, paymentDueDate: { not: null } },
      select: {
        id: true,
        orderNumber: true,
        grandTotalMinor: true,
        paymentDueDate: true,
        customer: { select: { companyName: true } },
        payments: { where: { status: 'CONFIRMED' }, select: { amountConfirmedMinor: true } },
      },
    });

    for (const order of orders) {
      const confirmed = order.payments.reduce(
        (sum, payment) => sum + (payment.amountConfirmedMinor ?? 0n),
        0n,
      );
      const outstanding = order.grandTotalMinor - confirmed;
      if (outstanding <= 0n) continue;

      const days = compareDateToLocalToday(order.paymentDueDate!, timezone, asOf);
      if (days > 0) continue;

      items.push({
        kind: days < 0 ? 'OVERDUE_RECEIVABLE' : 'RECEIVABLE_DUE_TODAY',
        severity: days < 0 ? 'HIGH' : 'NORMAL',
        entityId: order.id,
        reference: order.orderNumber,
        title:
          days < 0
            ? `${order.customer.companyName} is ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
            : `${order.customer.companyName} is due today`,
        ageHours: Math.abs(days) * 24,
        amountMinor: outstanding,
        href: `/orders/${order.id}`,
      });
    }

    const claims = await tx.payment.findMany({
      where: { status: { in: ['SUBMITTED', 'NEEDS_REVIEW'] } },
      select: {
        id: true,
        amountClaimedMinor: true,
        createdAt: true,
        salesOrder: { select: { orderNumber: true } },
        customer: { select: { companyName: true } },
      },
    });

    for (const claim of claims) {
      const ageHours = hoursSince(claim.createdAt, asOf);
      items.push({
        kind: 'PAYMENT_AWAITING_REVIEW',
        // A claim submitted this morning is a queue; one still sitting tomorrow is a customer
        // wondering why their goods have not moved.
        severity: ageHours >= PAYMENT_REVIEW_HOURS ? 'HIGH' : 'NORMAL',
        entityId: claim.id,
        reference: claim.salesOrder.orderNumber,
        title: `${claim.customer.companyName} says they paid for ${claim.salesOrder.orderNumber}`,
        ageHours,
        amountMinor: claim.amountClaimedMinor,
        href: `/payments/${claim.id}`,
      });
    }
  }

  // --- sales: approvals and follow-ups -------------------------------------
  if (scope.sales) {
    const awaiting = await tx.quotation.findMany({
      where: { status: 'PENDING_APPROVAL' },
      select: {
        id: true,
        quotationNumber: true,
        submittedAt: true,
        grandTotalMinor: true,
        customer: { select: { companyName: true } },
      },
    });

    for (const row of awaiting) {
      items.push({
        kind: 'QUOTATION_AWAITING_APPROVAL',
        severity: 'NORMAL',
        entityId: row.id,
        reference: row.quotationNumber,
        title: `${row.customer.companyName}: quotation waiting for approval`,
        ageHours: hoursSince(row.submittedAt, asOf),
        amountMinor: scope.money ? row.grandTotalMinor : null,
        href: `/quotations/${row.id}`,
      });
    }

    const followUps = await tx.quotationFollowUp.findMany({
      where: { status: 'DUE', dueAt: { lt: asOf } },
      select: {
        id: true,
        dueAt: true,
        quotation: {
          select: {
            id: true,
            quotationNumber: true,
            grandTotalMinor: true,
            customer: { select: { companyName: true } },
          },
        },
      },
    });

    for (const row of followUps) {
      items.push({
        kind: 'FOLLOW_UP_OVERDUE',
        severity: 'HIGH',
        entityId: row.id,
        reference: row.quotation.quotationNumber,
        title: `${row.quotation.customer.companyName}: quotation follow-up is overdue`,
        ageHours: hoursSince(row.dueAt, asOf),
        amountMinor: scope.money ? row.quotation.grandTotalMinor : null,
        href: `/quotations/${row.quotation.id}`,
      });
    }
  }

  const ordered = prioritiseAttention(items);
  return options.limit ? ordered.slice(0, options.limit) : ordered;
}
