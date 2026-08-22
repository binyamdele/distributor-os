/**
 * Inventory discrepancy arithmetic and policy.
 *
 * Pure, so the rule that decides whether a stock correction may be written is enumerable in a
 * unit test rather than inferred from a transaction.
 *
 * ## The distinction the whole domain rests on
 *
 * **Reporting a count is not correcting stock.** A warehouse worker who types "I found 60" has
 * made an observation; the system records the observation and changes nothing. Somebody else
 * decides whether the observation becomes the truth. Collapsing the two would mean any single
 * person could rewrite inventory by typing a number into a box, and the record of what the
 * system used to claim — the only thing that makes the disagreement investigable — would be
 * gone the moment it was created.
 */

export const DISCREPANCY_TYPES = [
  'PHYSICAL_SHORTAGE',
  'PHYSICAL_OVERAGE',
  'DAMAGED_STOCK',
  'RESERVATION_MISMATCH',
  'OTHER',
] as const;
export type DiscrepancyType = (typeof DISCREPANCY_TYPES)[number];

export const DISCREPANCY_STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CANCELLED'] as const;
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];

export const DISCREPANCY_RESOLUTIONS = [
  'STOCK_RECONCILED',
  'COUNT_CONFIRMED_NO_CHANGE',
  'NO_ACTION_REQUIRED',
] as const;
export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number];

const TRANSITIONS: Readonly<Record<DiscrepancyStatus, readonly DiscrepancyStatus[]>> = {
  OPEN: ['UNDER_REVIEW', 'RESOLVED', 'CANCELLED'],
  UNDER_REVIEW: ['RESOLVED', 'CANCELLED', 'OPEN'],
  // Terminal. A resolved discrepancy is the record of a decision somebody made about physical
  // stock; reopening it in place would erase which decision was made and when.
  RESOLVED: [],
  CANCELLED: [],
};

export function canTransitionDiscrepancy(
  from: DiscrepancyStatus,
  to: DiscrepancyStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** True while the discrepancy still blocks anything. */
export function isDiscrepancyOpen(status: DiscrepancyStatus): boolean {
  return status === 'OPEN' || status === 'UNDER_REVIEW';
}

/**
 * The variance, and the kind of discrepancy it implies.
 *
 * Negative variance is a shortage — the yard has less than the system believes, which is the
 * expensive direction because it means goods have been promised that do not exist. Positive is
 * an overage, which is a smaller problem and still a real one: stock nobody knew about is stock
 * nobody sold.
 */
export function classifyVariance(
  systemOnHand: number,
  physicalCount: number,
): { variance: number; type: DiscrepancyType } {
  const variance = physicalCount - systemOnHand;
  if (variance < 0) return { variance, type: 'PHYSICAL_SHORTAGE' };
  if (variance > 0) return { variance, type: 'PHYSICAL_OVERAGE' };
  return { variance: 0, type: 'OTHER' };
}

export interface ReconciliationInputs {
  readonly status: DiscrepancyStatus;
  /** The figure the system holds *now*, re-read inside the lock. */
  readonly currentOnHand: number;
  /** The sum of ACTIVE reservations against this product *now*. */
  readonly currentReserved: number;
  /** What was counted on the shelf. */
  readonly physicalCount: number;
  /** The on-hand figure recorded when the discrepancy was reported. */
  readonly reportedSystemOnHand: number;
}

export type ReconciliationRefusal =
  | 'ALREADY_RESOLVED'
  | 'CANCELLED'
  | 'STOCK_MOVED_SINCE_REPORT'
  | 'RESERVATION_SHORTFALL'
  | 'NOTHING_TO_CHANGE';

export interface ReconciliationVerdict {
  readonly canApply: boolean;
  readonly refusal: ReconciliationRefusal | null;
  /** The signed change to `available_stock`. Zero when there is nothing to do. */
  readonly delta: number;
  /** How much committed stock the verified count cannot cover. Zero when it can. */
  readonly reservationShortfall: number;
  readonly detail: string;
}

/**
 * Whether a verified physical count may be written into stock.
 *
 * Four refusals, and the interesting one is the third:
 *
 *   - **Already resolved / cancelled.** A discrepancy resolves once. The database enforces this
 *     with a trigger as well, because a double-applied correction is a silent double adjustment.
 *   - **Stock moved since the report.** The count was taken against a figure that has since
 *     changed — a sale shipped, another correction landed. Applying a delta computed from a
 *     stale baseline would write a number nobody counted. The right answer is to count again.
 *   - **Reservation shortfall.** The count is lower than what is already committed to orders.
 *     Persisting it would leave `available_stock < reserved_stock`, which the database refuses
 *     and which would in any case be a promise the yard cannot keep. This is *not* solved by
 *     shrinking reservations here: which customer gives way is a commercial decision with a
 *     phone call attached, and it belongs to sales.
 *   - **Nothing to change.** The recount agreed with the system. Still worth resolving, as
 *     `COUNT_CONFIRMED_NO_CHANGE` — the count happened and the record should say so.
 */
export function assessReconciliation(inputs: ReconciliationInputs): ReconciliationVerdict {
  const nil = { delta: 0, reservationShortfall: 0 };

  if (inputs.status === 'RESOLVED') {
    return {
      canApply: false,
      refusal: 'ALREADY_RESOLVED',
      ...nil,
      detail: 'This discrepancy has already been resolved.',
    };
  }
  if (inputs.status === 'CANCELLED') {
    return {
      canApply: false,
      refusal: 'CANCELLED',
      ...nil,
      detail: 'This discrepancy was cancelled.',
    };
  }

  if (inputs.currentOnHand !== inputs.reportedSystemOnHand) {
    return {
      canApply: false,
      refusal: 'STOCK_MOVED_SINCE_REPORT',
      ...nil,
      detail: `Stock has changed since the count was taken — it was ${inputs.reportedSystemOnHand} and is now ${inputs.currentOnHand}. Count again before reconciling.`,
    };
  }

  const delta = inputs.physicalCount - inputs.currentOnHand;

  if (delta === 0) {
    return {
      canApply: false,
      refusal: 'NOTHING_TO_CHANGE',
      ...nil,
      detail: 'The count agrees with the system. Nothing needs to move.',
    };
  }

  if (inputs.physicalCount < inputs.currentReserved) {
    const shortfall = inputs.currentReserved - inputs.physicalCount;
    return {
      canApply: false,
      refusal: 'RESERVATION_SHORTFALL',
      delta,
      reservationShortfall: shortfall,
      detail: `${inputs.currentReserved} is committed to orders and only ${inputs.physicalCount} was counted. ${shortfall} more is promised than exists, so a reservation has to be reduced before the count can be recorded.`,
    };
  }

  return {
    canApply: true,
    refusal: null,
    delta,
    reservationShortfall: 0,
    detail:
      delta < 0
        ? `Reduce recorded stock by ${Math.abs(delta)} to match the verified count.`
        : `Increase recorded stock by ${delta} to match the verified count.`,
  };
}

export interface AffectedReservation {
  readonly reservationId: string;
  readonly salesOrderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly quantity: number;
  readonly createdAt: Date;
}

/**
 * The orders whose stock is at risk, in a deliberately unopinionated order.
 *
 * Sorted by order number — which is to say, by nothing meaningful. **No ranking is applied**:
 * not oldest first, not largest first, not by customer value, and certainly not by a model.
 * Deciding which customer does not get their cement is a commercial judgement with a
 * relationship behind it, and a list that arrived pre-sorted by "priority" would be making that
 * judgement while appearing merely to display information.
 *
 * The person choosing gets the facts — who, how much, since when — and chooses.
 */
export function affectedByShortfall(
  reservations: readonly AffectedReservation[],
  shortfall: number,
): { reservations: readonly AffectedReservation[]; shortfall: number; totalCommitted: number } {
  const sorted = [...reservations].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
  return {
    reservations: sorted,
    shortfall,
    totalCommitted: reservations.reduce((sum, reservation) => sum + reservation.quantity, 0),
  };
}

/**
 * Whether reducing a reservation leaves the order short of what was accepted.
 *
 * The order's commercial quantity is never touched — that is what the customer agreed to buy,
 * and rewriting it to make a warehouse problem disappear would be falsifying the agreement. So
 * the order is left saying "80 required, 60 reserved", carrying a visible operational
 * exception, which is the honest description of the situation.
 */
export function shortfallLeavesOrderUnfulfillable(
  requiredQuantity: number,
  reservedAfter: number,
): { unfulfillable: boolean; shortfall: number } {
  const shortfall = Math.max(0, requiredQuantity - reservedAfter);
  return { unfulfillable: shortfall > 0, shortfall };
}
