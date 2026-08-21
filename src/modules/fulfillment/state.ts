/**
 * The warehouse task and delivery state machines.
 *
 * Pure, so the rules that decide whether goods may leave a yard are enumerable in a unit test
 * rather than inferred from a transaction.
 *
 * ## Why three axes and not one
 *
 * An order carries `paymentStatus`, `fulfillmentStatus` and — from this phase — a warehouse
 * task status and a delivery status. Four values where a simpler product would have one.
 *
 * They are separate because they answer different questions, are decided by different people,
 * and move at different times. Finance decides whether money arrived. The warehouse decides
 * whether goods were picked and handed over. Whoever drove decides whether the customer got
 * them. A single `status` column forces those three into a total order that reality does not
 * have: a credit order can be delivered and unpaid, a paid order can sit unpicked for a week,
 * and a delivery can fail while both the money and the picking were fine.
 *
 * The cost of collapsing them is not abstract. It is a warehouse releasing goods because
 * somebody needed a value for "done".
 */

export const WAREHOUSE_TASK_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'PREPARED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type WarehouseTaskStatus = (typeof WAREHOUSE_TASK_STATUSES)[number];

/**
 * Permitted transitions.
 *
 * `COMPLETED` is terminal, and terminal for a physical reason: completion is the moment stock
 * is consumed and goods leave warehouse custody. There is no transition back because there is
 * no operation that un-ships something. Returns are a later phase and a different event.
 */
const TASK_TRANSITIONS: Readonly<Record<WarehouseTaskStatus, readonly WarehouseTaskStatus[]>> = {
  PENDING: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PREPARED', 'CANCELLED'],
  // A prepared task may still be cancelled: the goods are picked but have not left, so putting
  // them back is a matter of walking them to the shelf, not of inventing inventory.
  PREPARED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionTask(
  from: WarehouseTaskStatus,
  to: WarehouseTaskStatus,
): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** True while the task still has work left in it. */
export function isTaskOpen(status: WarehouseTaskStatus): boolean {
  return status === 'PENDING' || status === 'IN_PROGRESS' || status === 'PREPARED';
}

/**
 * True once the warehouse has physically started on the order.
 *
 * The line cancellation cares about. Before it, an order is a promise and cancelling one costs
 * a conversation. After it, someone has walked the yard with a trolley.
 */
export function taskHasStarted(status: WarehouseTaskStatus): boolean {
  return status === 'IN_PROGRESS' || status === 'PREPARED' || status === 'COMPLETED';
}

export const DELIVERY_STATUSES = [
  'PENDING',
  'ASSIGNED',
  'DISPATCHED',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Delivery transitions.
 *
 * `FAILED` is terminal in this phase, and that is the honest position rather than a limitation
 * to apologise for. A failed delivery means goods are somewhere between the yard and the
 * customer. Offering "retry" would imply the system knows where they are; offering "return to
 * stock" would put quantity back that nobody has counted. Both are lies a warehouse pays for.
 * What the product can honestly do is record the failure and let a person deal with it.
 */
const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  PENDING: ['ASSIGNED', 'DISPATCHED', 'CANCELLED'],
  ASSIGNED: ['DISPATCHED', 'PENDING', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function isDeliveryOpen(status: DeliveryStatus): boolean {
  return status === 'PENDING' || status === 'ASSIGNED' || status === 'DISPATCHED';
}

export const DELIVERY_FAILURE_REASONS = [
  'CUSTOMER_UNAVAILABLE',
  'WRONG_ADDRESS',
  'VEHICLE_ISSUE',
  'CUSTOMER_REJECTED',
  'OTHER',
] as const;
export type DeliveryFailureReason = (typeof DELIVERY_FAILURE_REASONS)[number];

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface OrderReadiness {
  readonly status: string;
  readonly paymentStatus: string;
  readonly fulfillmentStatus: string;
  readonly paymentType: 'CASH' | 'CREDIT';
}

export type EligibilityRefusal =
  | 'ORDER_NOT_OPEN'
  | 'FULFILLMENT_NOT_READY'
  | 'CASH_NOT_PAID'
  | 'NO_RESERVED_LINES';

export interface EligibilityVerdict {
  readonly eligible: boolean;
  readonly refusal: EligibilityRefusal | null;
  readonly detail: string;
}

/**
 * Whether an order may enter the warehouse workflow.
 *
 * Reads stored, authoritative state and nothing else. It does **not** sum payments, compare
 * amounts, or decide for itself what "paid enough" means — Phase 5 owns that question and
 * writes its answer into `paymentStatus` and `fulfillmentStatus`. A second implementation of
 * the payment rule living in the warehouse module is how the two drift apart, and the day they
 * disagree is the day goods go out against money that never arrived.
 *
 * `fulfillmentStatus === 'READY'` is the load-bearing check. For a cash order that value can
 * only have been written by a confirmed payment that settled the balance in full; for a credit
 * order it was written at conversion, because the customer already has terms. The cash payment
 * check below is therefore redundant by construction — and it is here anyway, because a
 * redundant read of a stored column costs nothing and would catch the one bug that matters.
 */
export function assessEligibility(
  order: OrderReadiness,
  reservedLineCount: number,
): EligibilityVerdict {
  if (order.status !== 'OPEN') {
    return {
      eligible: false,
      refusal: 'ORDER_NOT_OPEN',
      detail: `This order is ${order.status.toLowerCase()}, so it cannot go to the warehouse.`,
    };
  }

  if (order.fulfillmentStatus !== 'READY') {
    return {
      eligible: false,
      refusal: 'FULFILLMENT_NOT_READY',
      detail:
        order.paymentType === 'CASH'
          ? 'This is a cash order and the payment has not been confirmed in full, so the goods are not released.'
          : 'This order is not marked ready for fulfilment.',
    };
  }

  if (order.paymentType === 'CASH' && order.paymentStatus !== 'PAID') {
    return {
      eligible: false,
      refusal: 'CASH_NOT_PAID',
      detail: `This cash order is ${order.paymentStatus.toLowerCase().replace(/_/g, ' ')}, so the goods are not released.`,
    };
  }

  if (reservedLineCount === 0) {
    return {
      eligible: false,
      refusal: 'NO_RESERVED_LINES',
      detail: 'Nothing is reserved against this order, so there is nothing to prepare.',
    };
  }

  return { eligible: true, refusal: null, detail: 'Ready for the warehouse.' };
}

// ---------------------------------------------------------------------------
// Order completion
// ---------------------------------------------------------------------------

export interface CompletionInputs {
  readonly paymentType: 'CASH' | 'CREDIT';
  readonly paymentStatus: string;
  readonly deliveryRequired: boolean;
  readonly warehouseTaskStatus: WarehouseTaskStatus | null;
  readonly deliveryStatus: DeliveryStatus | null;
  readonly pickedUp: boolean;
}

export type CompletionBlocker =
  | 'WAREHOUSE_NOT_COMPLETE'
  | 'DELIVERY_NOT_DELIVERED'
  | 'PICKUP_NOT_RECORDED'
  | 'CASH_NOT_PAID';

/**
 * Whether an order has been operationally completed.
 *
 * **Completion is about goods, not money — with one exception.** A delivered credit order is
 * finished operationally and still owes its balance; it stays in receivables until the money is
 * confirmed, and nothing about `COMPLETED` removes it from that list. Coupling completion to
 * `PAID` for credit would erase a debt by delivering it, which is the most expensive bug this
 * phase could contain.
 *
 * The exception is cash, where `PAID` was already required before the warehouse could start.
 * Re-reading it here is not re-running the payment rule; it is checking that the state which
 * let the goods out is still the state on the row.
 */
export function assessCompletion(inputs: CompletionInputs): {
  complete: boolean;
  blocker: CompletionBlocker | null;
} {
  if (inputs.warehouseTaskStatus !== 'COMPLETED') {
    return { complete: false, blocker: 'WAREHOUSE_NOT_COMPLETE' };
  }

  if (inputs.paymentType === 'CASH' && inputs.paymentStatus !== 'PAID') {
    return { complete: false, blocker: 'CASH_NOT_PAID' };
  }

  if (inputs.deliveryRequired) {
    if (inputs.deliveryStatus !== 'DELIVERED') {
      return { complete: false, blocker: 'DELIVERY_NOT_DELIVERED' };
    }
    return { complete: true, blocker: null };
  }

  if (!inputs.pickedUp) return { complete: false, blocker: 'PICKUP_NOT_RECORDED' };
  return { complete: true, blocker: null };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export type CancellationBlocker = 'WAREHOUSE_STARTED' | 'STOCK_CONSUMED';

/**
 * Whether fulfilment progress blocks cancelling an order.
 *
 * Phase 5 established that confirmed money blocks cancellation. Phase 6 adds the physical half:
 *
 *   - **Once picking has started**, cancelling is refused. Someone is walking the yard against
 *     this order, and a cancellation that races them leaves a trolley of goods belonging to an
 *     order that no longer exists. Cancel the task first, deliberately, then the order.
 *   - **Once stock is consumed**, cancelling is refused permanently. The goods are gone.
 *     Restoring inventory on cancellation would invent quantity that nobody has counted, and it
 *     would do so at exactly the moment the numbers matter most.
 *
 * A PENDING task does not block: nothing has happened yet, and cancelling releases it with the
 * order's reservations.
 */
export function assessCancellation(taskStatus: WarehouseTaskStatus | null): {
  allowed: boolean;
  blocker: CancellationBlocker | null;
  detail: string;
} {
  if (taskStatus === null || taskStatus === 'PENDING' || taskStatus === 'CANCELLED') {
    return { allowed: true, blocker: null, detail: '' };
  }

  if (taskStatus === 'COMPLETED') {
    return {
      allowed: false,
      blocker: 'STOCK_CONSUMED',
      detail:
        'The goods for this order have already left the warehouse, so it cannot be cancelled. A return has to be recorded against the stock instead.',
    };
  }

  return {
    allowed: false,
    blocker: 'WAREHOUSE_STARTED',
    detail:
      'The warehouse has started preparing this order. Cancel the warehouse task first, then cancel the order.',
  };
}
