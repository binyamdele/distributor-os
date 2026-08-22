/**
 * Return arithmetic and the delivery-failure resolution model.
 *
 * Pure. The rule that decides how much of a returned load goes back on the sellable shelf is
 * worth being able to enumerate in a unit test rather than reconstruct from a stock figure
 * after somebody notices it looks wrong.
 *
 * ## The invariant, stated once
 *
 *     received  = restockable + damaged
 *     expected  = received + missing
 *
 * Both halves matter, and they fail differently. Without the first, quantity could be restocked
 * that was never inspected. Without the second, goods that simply failed to arrive would drop
 * out of the sum rather than being recorded as missing — and "eighty went out, seventy-six came
 * back" would leave four units that the history cannot account for at all.
 *
 * **Only `restockable` increases sellable stock.** Damaged goods are physically present and
 * commercially worthless; putting them back on `available_stock` would offer a customer a broken
 * bag of cement. Missing goods are not present at all. Both are kept in the record because a
 * quantity that disappears from history is a quantity nobody can be asked about.
 */

export const RETURN_STATUSES = [
  'EXPECTED',
  'RECEIVED',
  'INSPECTED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

const RETURN_TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  EXPECTED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['INSPECTED', 'CANCELLED'],
  // Cancellable right up to the point stock moves — nothing physical has been changed yet.
  INSPECTED: ['COMPLETED', 'CANCELLED'],
  // Terminal: stock has moved, and there is no operation that un-restocks something.
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionReturn(from: ReturnStatus, to: ReturnStatus): boolean {
  return RETURN_TRANSITIONS[from].includes(to);
}

export function isReturnOpen(status: ReturnStatus): boolean {
  return status === 'EXPECTED' || status === 'RECEIVED' || status === 'INSPECTED';
}

export const RETURN_REASONS = [
  'DELIVERY_FAILED',
  'CUSTOMER_REJECTED',
  'WRONG_GOODS',
  'DAMAGED_IN_TRANSIT',
  'OTHER',
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_DISPOSITIONS = ['RESTOCK', 'DAMAGED', 'MISSING', 'MIXED'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export interface InspectionInput {
  readonly quantityDispatched: number;
  readonly quantityExpected: number;
  readonly quantityReceived: number;
  readonly quantityRestockable: number;
  readonly quantityDamaged: number;
}

export type InspectionProblem =
  | 'EXCEEDS_DISPATCHED'
  | 'EXCEEDS_EXPECTED'
  | 'SPLIT_DOES_NOT_SUM'
  | 'NEGATIVE_QUANTITY';

export interface InspectionVerdict {
  readonly valid: boolean;
  readonly problem: InspectionProblem | null;
  readonly quantityMissing: number;
  readonly disposition: ReturnDisposition;
  readonly detail: string;
}

/**
 * Checks one inspected line and works out what is missing.
 *
 * `missing` is derived rather than entered, because it is the residual — what was expected back
 * and did not appear. Letting someone type it independently would allow the two halves of the
 * invariant to be satisfied by adjusting the wrong number.
 */
export function assessInspection(input: InspectionInput): InspectionVerdict {
  const none = { quantityMissing: 0, disposition: 'RESTOCK' as ReturnDisposition };

  if (
    input.quantityExpected < 0 ||
    input.quantityReceived < 0 ||
    input.quantityRestockable < 0 ||
    input.quantityDamaged < 0
  ) {
    return {
      valid: false,
      problem: 'NEGATIVE_QUANTITY',
      ...none,
      detail: 'Quantities cannot be negative.',
    };
  }

  if (input.quantityExpected > input.quantityDispatched) {
    return {
      valid: false,
      problem: 'EXCEEDS_DISPATCHED',
      ...none,
      detail: `Only ${input.quantityDispatched} went out; ${input.quantityExpected} cannot come back.`,
    };
  }

  if (input.quantityReceived > input.quantityExpected) {
    return {
      valid: false,
      problem: 'EXCEEDS_EXPECTED',
      ...none,
      detail: `${input.quantityExpected} was expected back and ${input.quantityReceived} was recorded as received.`,
    };
  }

  if (input.quantityRestockable + input.quantityDamaged !== input.quantityReceived) {
    return {
      valid: false,
      problem: 'SPLIT_DOES_NOT_SUM',
      ...none,
      detail: `${input.quantityReceived} came back, but ${input.quantityRestockable} sellable plus ${input.quantityDamaged} damaged is ${
        input.quantityRestockable + input.quantityDamaged
      }. Every unit has to be one or the other.`,
    };
  }

  const quantityMissing = input.quantityExpected - input.quantityReceived;

  let disposition: ReturnDisposition = 'RESTOCK';
  if (input.quantityRestockable === 0 && input.quantityDamaged > 0) disposition = 'DAMAGED';
  else if (input.quantityReceived === 0 && quantityMissing > 0) disposition = 'MISSING';
  else if (input.quantityDamaged > 0 || quantityMissing > 0) disposition = 'MIXED';

  return {
    valid: true,
    problem: null,
    quantityMissing,
    disposition,
    detail: '',
  };
}

/**
 * What a completed return does to sellable stock: the restockable quantity, and only that.
 *
 * Reserved stock is deliberately untouched. The original reservation was consumed when the goods
 * left, and it stays consumed — those units were shipped, and they were shipped against that
 * order. Recreating the reservation would claim the order is committed stock again, which is
 * false: the goods came back to the shelf as free stock, and whether this customer still wants
 * them is an open commercial question rather than something the warehouse should assume.
 */
export function restockEffect(
  items: readonly { productId: string; quantityRestockable: number }[],
): Map<string, number> {
  const byProduct = new Map<string, number>();
  for (const item of items) {
    if (item.quantityRestockable <= 0) continue;
    byProduct.set(item.productId, (byProduct.get(item.productId) ?? 0) + item.quantityRestockable);
  }
  return byProduct;
}

/** What a completed return accounts for, per line. Nothing is allowed to vanish. */
export function accountFor(
  items: readonly {
    quantityDispatched: number;
    quantityRestockable: number;
    quantityDamaged: number;
    quantityMissing: number;
  }[],
): { dispatched: number; restocked: number; damaged: number; missing: number; unaccounted: number } {
  const totals = items.reduce(
    (sum, item) => ({
      dispatched: sum.dispatched + item.quantityDispatched,
      restocked: sum.restocked + item.quantityRestockable,
      damaged: sum.damaged + item.quantityDamaged,
      missing: sum.missing + item.quantityMissing,
    }),
    { dispatched: 0, restocked: 0, damaged: 0, missing: 0 },
  );

  return {
    ...totals,
    // Whatever was dispatched and is not in one of the three buckets stayed with the customer.
    // Not an error — a partly returned load is legitimate — but a number worth being able to see.
    unaccounted: totals.dispatched - totals.restocked - totals.damaged - totals.missing,
  };
}

// ---------------------------------------------------------------------------
// Failed-delivery resolution
// ---------------------------------------------------------------------------

export const FAILURE_RESOLUTIONS = [
  'RETRY_DELIVERY',
  'RETURNED_TO_WAREHOUSE',
  'LOST_OR_UNRECOVERABLE',
] as const;
export type FailureResolution = (typeof FAILURE_RESOLUTIONS)[number];

export interface RetryEligibility {
  readonly deliveryStatus: string;
  readonly existingResolution: FailureResolution | null;
  /** True once a return against this delivery has actually put goods back on the shelf. */
  readonly goodsRestocked: boolean;
  readonly hasLiveRetry: boolean;
  readonly orderStatus: string;
}

export type RetryRefusal =
  | 'NOT_FAILED'
  | 'ALREADY_RESOLVED'
  | 'GOODS_BACK_IN_WAREHOUSE'
  | 'RETRY_ALREADY_EXISTS'
  | 'ORDER_NOT_OPEN';

/**
 * Whether a failed delivery may be sent out again without touching stock.
 *
 * The load-bearing refusal is `GOODS_BACK_IN_WAREHOUSE`. A retry is only honest while custody
 * never left the logistics operation — the goods are still on the lorry, and sending them out
 * again moves nothing. Once a return has restocked them, they are on the shelf as free stock and
 * dispatching them again without consuming stock would ship inventory the system still counts.
 * That path is a re-fulfilment: a new warehouse task, a new consumption, and a workflow this
 * phase deliberately does not build. Offering "retry" there would be the confusing path §23
 * warns about, so it is refused with the reason said plainly.
 */
export function assessRetryEligibility(inputs: RetryEligibility): {
  eligible: boolean;
  refusal: RetryRefusal | null;
  detail: string;
} {
  if (inputs.deliveryStatus !== 'FAILED') {
    return {
      eligible: false,
      refusal: 'NOT_FAILED',
      detail: 'Only a failed delivery can be retried.',
    };
  }
  if (inputs.orderStatus !== 'OPEN') {
    return {
      eligible: false,
      refusal: 'ORDER_NOT_OPEN',
      detail: `This order is ${inputs.orderStatus.toLowerCase()}, so nothing more can be sent out against it.`,
    };
  }
  if (inputs.goodsRestocked) {
    return {
      eligible: false,
      refusal: 'GOODS_BACK_IN_WAREHOUSE',
      detail:
        'These goods came back to the warehouse and are counted as stock again. Sending them out has to go through the warehouse, so that stock is consumed for the trip — a retry would move a lorry the system thinks is still full.',
    };
  }
  if (inputs.hasLiveRetry) {
    return {
      eligible: false,
      refusal: 'RETRY_ALREADY_EXISTS',
      detail: 'A retry for this delivery already exists.',
    };
  }
  if (inputs.existingResolution && inputs.existingResolution !== 'RETRY_DELIVERY') {
    return {
      eligible: false,
      refusal: 'ALREADY_RESOLVED',
      detail: `This failure was already resolved as ${inputs.existingResolution.toLowerCase().replace(/_/g, ' ')}.`,
    };
  }

  return { eligible: true, refusal: null, detail: '' };
}
