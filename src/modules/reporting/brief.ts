import { formatMoney } from '@/platform/money';
import type { DashboardSnapshot } from './snapshot';

/**
 * The daily business brief.
 *
 * **The deterministic version is written first and is the default.** Everything an owner needs
 * to read over their morning coffee is produced here from the snapshot, with no provider, no key
 * and no network. AI narration is an enhancement layered on top; if it is unavailable, fails,
 * returns the wrong shape, or states a figure that is not in the snapshot, the owner gets this
 * instead and loses nothing but some polish.
 *
 * That ordering is not an implementation detail. A brief that only exists when a model answers
 * is a brief that is missing on the morning the provider has an outage — which, for a daily
 * report, is the morning it is most conspicuous.
 */

export interface BriefLine {
  /** Already complete. The component prints it; it does not assemble it. */
  readonly text: string;
}

export interface DailyBrief {
  readonly summary: string;
  readonly highlights: readonly string[];
  readonly attention: readonly string[];
  /**
   * How this brief was produced.
   *
   * Surfaced so the UI can label it honestly. Claiming an AI-assisted summary when the fallback
   * is showing would be a small lie that costs the whole page its credibility.
   */
  readonly source: 'DETERMINISTIC' | 'AI';
}

function money(minor: bigint, currency: string): string {
  return formatMoney({ amountMinor: minor, currency });
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/**
 * Builds the brief from the snapshot alone.
 *
 * Sections are omitted rather than reported as zero when the role cannot see them, and
 * individual lines are omitted when there is nothing to say. A brief listing eight things that
 * are all zero teaches an owner to skim past it; one that says only what is true stays worth
 * reading.
 */
export function deterministicBrief(snapshot: DashboardSnapshot): DailyBrief {
  const { currency } = snapshot;
  const summaryParts: string[] = [];
  const highlights: string[] = [];
  const attention: string[] = [];

  if (snapshot.sales) {
    const sales = snapshot.sales;

    if (sales.ordersCreated > 0) {
      summaryParts.push(
        `${plural(sales.ordersCreated, 'sales order')} worth ${money(sales.orderValueTodayMinor, currency)}`,
      );
    }
    if (sales.quotationsCreated > 0) {
      summaryParts.push(
        `${plural(sales.quotationsCreated, 'quotation')} worth ${money(sales.quotationValueTodayMinor, currency)}`,
      );
    }

    if (sales.quotationsAccepted > 0) {
      highlights.push(
        `${plural(sales.quotationsAccepted, 'quotation')} accepted, worth ${money(sales.acceptedValueTodayMinor, currency)}.`,
      );
    }
    if (sales.quotationsRejected > 0) {
      highlights.push(`${plural(sales.quotationsRejected, 'quotation')} rejected.`);
    }
    // Stated only when a rate exists. A zero denominator has no percentage, and printing 0%
    // would read as having lost everything on a day when nothing was decided at all.
    if (sales.acceptanceRate !== null) {
      highlights.push(
        `${Math.round(sales.acceptanceRate * 100)}% of quotations decided today were accepted.`,
      );
    }
    if (sales.largestOrder) {
      highlights.push(
        `The largest order today was ${sales.largestOrder.orderNumber} for ${sales.largestOrder.customerName}, at ${money(sales.largestOrder.valueMinor, currency)}.`,
      );
    }
  }

  if (snapshot.cash) {
    const cash = snapshot.cash;

    if (cash.paymentsConfirmedToday > 0) {
      summaryParts.push(
        `${money(cash.paymentsConfirmedTodayMinor, currency)} in confirmed payments`,
      );
    }

    if (cash.overdueReceivablesMinor > 0n) {
      attention.push(
        `${money(cash.overdueReceivablesMinor, currency)} is overdue across ${plural(cash.overdueCount, 'order')}.`,
      );
    }
    if (cash.dueTodayMinor > 0n) {
      attention.push(`${money(cash.dueTodayMinor, currency)} falls due today.`);
    }
    if (cash.paymentsAwaitingReview > 0) {
      attention.push(
        `${plural(cash.paymentsAwaitingReview, 'payment')} awaiting Finance review.`,
      );
    }
    if (cash.partiallyPaidCashOrders > 0) {
      attention.push(
        `${plural(cash.partiallyPaidCashOrders, 'cash order')} part paid and not yet released.`,
      );
    }
  }

  if (snapshot.pipeline) {
    const pipeline = snapshot.pipeline;
    if (pipeline.followUpsOverdue > 0) {
      attention.push(`${plural(pipeline.followUpsOverdue, 'quotation follow-up')} overdue.`);
    }
    if (pipeline.quotationsAwaitingApproval > 0) {
      attention.push(
        `${plural(pipeline.quotationsAwaitingApproval, 'quotation')} waiting for approval.`,
      );
    }
    if (pipeline.inquiriesAwaitingReview > 0) {
      attention.push(
        `${plural(pipeline.inquiriesAwaitingReview, 'inquiry', 'inquiries')} still to be reviewed.`,
      );
    }
  }

  if (snapshot.operations) {
    const ops = snapshot.operations;
    if (ops.ordersCompletedToday > 0) {
      highlights.push(`${plural(ops.ordersCompletedToday, 'order')} completed today.`);
    }
    if (ops.ordersAwaitingWarehouse > 0) {
      attention.push(
        `${plural(ops.ordersAwaitingWarehouse, 'order')} cleared for the warehouse and not yet started.`,
      );
    }
    if (ops.deliveriesPending > 0) {
      attention.push(`${plural(ops.deliveriesPending, 'delivery', 'deliveries')} still to go out.`);
    }
    if (ops.failedDeliveriesOpen > 0) {
      attention.push(
        `${plural(ops.failedDeliveriesOpen, 'delivery failure')} without a resolution.`,
      );
    }
  }

  if (snapshot.inventory) {
    const inventory = snapshot.inventory;
    if (inventory.lowStockProducts > 0) {
      attention.push(
        `${plural(inventory.lowStockProducts, 'product')} at or below the reorder threshold.`,
      );
    }
    if (inventory.reservationShortfalls > 0) {
      attention.push(
        `${plural(inventory.reservationShortfalls, 'stock shortfall')} where more is promised than counted.`,
      );
    }
    if (inventory.openDiscrepancies > 0) {
      attention.push(
        `${plural(inventory.openDiscrepancies, 'inventory count')} open and unresolved.`,
      );
    }
    if (inventory.returnsAwaitingProcessing > 0) {
      attention.push(
        `${plural(inventory.returnsAwaitingProcessing, 'return')} still to be processed.`,
      );
    }
  }

  // The empty-state sentence. A new distributor should read something true and calm, not a wall
  // of zeroes and certainly not a percentage computed from nothing.
  const summary =
    summaryParts.length > 0
      ? `Today: ${joinWithAnd(summaryParts)}.`
      : 'Nothing has been recorded yet today.';

  return { summary, highlights, attention, source: 'DETERMINISTIC' };
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
