import { describe, expect, it } from 'vitest';
import {
  DELIVERY_FAILURE_REASONS,
  DELIVERY_STATUSES,
  WAREHOUSE_TASK_STATUSES,
  assessCancellation,
  assessCompletion,
  assessEligibility,
  canTransitionDelivery,
  canTransitionTask,
  isDeliveryOpen,
  isTaskOpen,
  taskHasStarted,
} from '@/modules/fulfillment';
import type { CompletionInputs, OrderReadiness } from '@/modules/fulfillment';
import { PRISMA_WAREHOUSE_TASK_STATUSES, PRISMA_DELIVERY_STATUSES } from '../support/prisma-meta';

const order = (overrides: Partial<OrderReadiness> = {}): OrderReadiness => ({
  status: 'OPEN',
  paymentStatus: 'PAID',
  fulfillmentStatus: 'READY',
  paymentType: 'CASH',
  ...overrides,
});

describe('the warehouse task state machine', () => {
  it('matches the enum in the database schema', () => {
    // Drift here would let a status exist in one place and not the other, which surfaces as a
    // task that saves and then cannot be read back.
    expect([...WAREHOUSE_TASK_STATUSES].sort()).toEqual([...PRISMA_WAREHOUSE_TASK_STATUSES].sort());
  });

  it('walks PENDING to COMPLETED one step at a time', () => {
    expect(canTransitionTask('PENDING', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionTask('IN_PROGRESS', 'PREPARED')).toBe(true);
    expect(canTransitionTask('PREPARED', 'COMPLETED')).toBe(true);
  });

  it('refuses to skip picking', () => {
    // Completing consumes stock. Reaching it without ever having picked would mean inventory
    // left the yard on the strength of one click.
    expect(canTransitionTask('PENDING', 'COMPLETED')).toBe(false);
    expect(canTransitionTask('PENDING', 'PREPARED')).toBe(false);
    expect(canTransitionTask('IN_PROGRESS', 'COMPLETED')).toBe(false);
  });

  it('treats COMPLETED as terminal, because shipping cannot be undone', () => {
    for (const status of WAREHOUSE_TASK_STATUSES) {
      expect(canTransitionTask('COMPLETED', status)).toBe(false);
    }
  });

  it('treats CANCELLED as terminal', () => {
    for (const status of WAREHOUSE_TASK_STATUSES) {
      expect(canTransitionTask('CANCELLED', status)).toBe(false);
    }
  });

  it('allows cancelling right up to the point goods leave', () => {
    // Picked goods are still on the premises; putting them back is a walk to the shelf.
    expect(canTransitionTask('PENDING', 'CANCELLED')).toBe(true);
    expect(canTransitionTask('IN_PROGRESS', 'CANCELLED')).toBe(true);
    expect(canTransitionTask('PREPARED', 'CANCELLED')).toBe(true);
    expect(canTransitionTask('COMPLETED', 'CANCELLED')).toBe(false);
  });

  it('never allows a status to transition to itself', () => {
    for (const status of WAREHOUSE_TASK_STATUSES) {
      expect(canTransitionTask(status, status)).toBe(false);
    }
  });

  it('knows which statuses still have work in them', () => {
    expect(isTaskOpen('PENDING')).toBe(true);
    expect(isTaskOpen('IN_PROGRESS')).toBe(true);
    expect(isTaskOpen('PREPARED')).toBe(true);
    expect(isTaskOpen('COMPLETED')).toBe(false);
    expect(isTaskOpen('CANCELLED')).toBe(false);
  });

  it('knows when the yard has physically started', () => {
    expect(taskHasStarted('PENDING')).toBe(false);
    expect(taskHasStarted('CANCELLED')).toBe(false);
    expect(taskHasStarted('IN_PROGRESS')).toBe(true);
    expect(taskHasStarted('PREPARED')).toBe(true);
    expect(taskHasStarted('COMPLETED')).toBe(true);
  });
});

describe('the delivery state machine', () => {
  it('matches the enum in the database schema', () => {
    expect([...DELIVERY_STATUSES].sort()).toEqual([...PRISMA_DELIVERY_STATUSES].sort());
  });

  it('goes out and then resolves one way or the other', () => {
    expect(canTransitionDelivery('PENDING', 'ASSIGNED')).toBe(true);
    expect(canTransitionDelivery('ASSIGNED', 'DISPATCHED')).toBe(true);
    expect(canTransitionDelivery('DISPATCHED', 'DELIVERED')).toBe(true);
    expect(canTransitionDelivery('DISPATCHED', 'FAILED')).toBe(true);
  });

  it('allows dispatching without a named driver', () => {
    // A small distributor sends the same three people out. Requiring an assignment step would
    // be a field to fill in rather than a control.
    expect(canTransitionDelivery('PENDING', 'DISPATCHED')).toBe(true);
  });

  it('cannot be delivered or failed before it went out', () => {
    for (const from of ['PENDING', 'ASSIGNED'] as const) {
      expect(canTransitionDelivery(from, 'DELIVERED')).toBe(false);
      expect(canTransitionDelivery(from, 'FAILED')).toBe(false);
    }
  });

  it('treats DELIVERED and FAILED as terminal', () => {
    for (const status of DELIVERY_STATUSES) {
      expect(canTransitionDelivery('DELIVERED', status)).toBe(false);
      // FAILED is terminal on purpose: the goods are somewhere, and offering a retry would
      // imply the system knows where.
      expect(canTransitionDelivery('FAILED', status)).toBe(false);
    }
  });

  it('cannot be cancelled once it is on the road', () => {
    expect(canTransitionDelivery('DISPATCHED', 'CANCELLED')).toBe(false);
  });

  it('knows which statuses are still live', () => {
    expect(isDeliveryOpen('PENDING')).toBe(true);
    expect(isDeliveryOpen('ASSIGNED')).toBe(true);
    expect(isDeliveryOpen('DISPATCHED')).toBe(true);
    expect(isDeliveryOpen('DELIVERED')).toBe(false);
    expect(isDeliveryOpen('FAILED')).toBe(false);
    expect(isDeliveryOpen('CANCELLED')).toBe(false);
  });

  it('offers exactly the failure reasons a driver actually reports', () => {
    expect([...DELIVERY_FAILURE_REASONS]).toEqual([
      'CUSTOMER_UNAVAILABLE',
      'WRONG_ADDRESS',
      'VEHICLE_ISSUE',
      'CUSTOMER_REJECTED',
      'OTHER',
    ]);
  });
});

describe('warehouse eligibility', () => {
  it('lets a paid, ready, open cash order through', () => {
    expect(assessEligibility(order(), 2)).toMatchObject({ eligible: true, refusal: null });
  });

  it('refuses an unpaid cash order', () => {
    const verdict = assessEligibility(
      order({ paymentStatus: 'UNPAID', fulfillmentStatus: 'NOT_READY' }),
      2,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.refusal).toBe('FULFILLMENT_NOT_READY');
    expect(verdict.detail).toMatch(/not been confirmed in full/);
  });

  it('refuses a partly paid cash order', () => {
    // The case the Phase 5 gate exists for. Half the money is not the goods.
    const verdict = assessEligibility(
      order({ paymentStatus: 'PARTIALLY_PAID', fulfillmentStatus: 'NOT_READY' }),
      2,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.refusal).toBe('FULFILLMENT_NOT_READY');
  });

  it('refuses a cash order that is READY but somehow not PAID', () => {
    // Unreachable by construction — only a settling confirmation writes READY on a cash order.
    // Checked anyway: it costs one comparison and it is the single bug that would matter.
    const verdict = assessEligibility(order({ paymentStatus: 'PARTIALLY_PAID' }), 2);
    expect(verdict.eligible).toBe(false);
    expect(verdict.refusal).toBe('CASH_NOT_PAID');
  });

  it('lets a credit order through with nothing paid', () => {
    // The customer has terms. Nothing is owed yet, and preparation may begin.
    const verdict = assessEligibility(
      order({ paymentType: 'CREDIT', paymentStatus: 'NOT_REQUIRED_YET' }),
      1,
    );
    expect(verdict.eligible).toBe(true);
  });

  it('lets an overdue credit order through', () => {
    // Being late is a collections problem, not a warehouse one. The goods were promised on
    // terms that were already granted.
    const verdict = assessEligibility(
      order({ paymentType: 'CREDIT', paymentStatus: 'UNPAID' }),
      1,
    );
    expect(verdict.eligible).toBe(true);
  });

  it('refuses a cancelled order', () => {
    const verdict = assessEligibility(order({ status: 'CANCELLED' }), 2);
    expect(verdict.refusal).toBe('ORDER_NOT_OPEN');
  });

  it('refuses a completed order', () => {
    expect(assessEligibility(order({ status: 'COMPLETED' }), 2).refusal).toBe('ORDER_NOT_OPEN');
  });

  it('refuses an order holding no stock', () => {
    const verdict = assessEligibility(order(), 0);
    expect(verdict.refusal).toBe('NO_RESERVED_LINES');
  });

  it('reports the order-level refusal before the payment one', () => {
    // A cancelled unpaid order should say it is cancelled. Reporting the payment problem would
    // send someone to chase money for an order that no longer exists.
    const verdict = assessEligibility(
      order({ status: 'CANCELLED', paymentStatus: 'UNPAID', fulfillmentStatus: 'NOT_READY' }),
      2,
    );
    expect(verdict.refusal).toBe('ORDER_NOT_OPEN');
  });
});

describe('order completion', () => {
  const inputs = (overrides: Partial<CompletionInputs> = {}): CompletionInputs => ({
    paymentType: 'CASH',
    paymentStatus: 'PAID',
    deliveryRequired: true,
    warehouseTaskStatus: 'COMPLETED',
    deliveryStatus: 'DELIVERED',
    pickedUp: false,
    ...overrides,
  });

  it('completes a delivered, paid cash order', () => {
    expect(assessCompletion(inputs())).toEqual({ complete: true, blocker: null });
  });

  it('does not complete before the warehouse hands over', () => {
    for (const status of ['PENDING', 'IN_PROGRESS', 'PREPARED'] as const) {
      expect(assessCompletion(inputs({ warehouseTaskStatus: status }))).toEqual({
        complete: false,
        blocker: 'WAREHOUSE_NOT_COMPLETE',
      });
    }
  });

  it('does not complete a dispatched delivery that has not arrived', () => {
    expect(assessCompletion(inputs({ deliveryStatus: 'DISPATCHED' }))).toEqual({
      complete: false,
      blocker: 'DELIVERY_NOT_DELIVERED',
    });
  });

  it('does not complete on a failed delivery', () => {
    // The goods left and did not arrive. That is the least finished an order can be.
    expect(assessCompletion(inputs({ deliveryStatus: 'FAILED' }))).toEqual({
      complete: false,
      blocker: 'DELIVERY_NOT_DELIVERED',
    });
  });

  it('completes a credit order that still owes every santim', () => {
    // The invariant this whole phase turns on. Delivering goods on 30-day terms finishes the
    // operation and settles nothing: coupling completion to PAID would erase a debt by
    // delivering it.
    const verdict = assessCompletion(
      inputs({ paymentType: 'CREDIT', paymentStatus: 'NOT_REQUIRED_YET' }),
    );
    expect(verdict).toEqual({ complete: true, blocker: null });
  });

  it('completes an overdue credit order too', () => {
    expect(assessCompletion(inputs({ paymentType: 'CREDIT', paymentStatus: 'UNPAID' }))).toEqual({
      complete: true,
      blocker: null,
    });
  });

  it('completes a part-paid credit order', () => {
    expect(
      assessCompletion(inputs({ paymentType: 'CREDIT', paymentStatus: 'PARTIALLY_PAID' })),
    ).toEqual({ complete: true, blocker: null });
  });

  it('refuses to complete a cash order that is no longer paid in full', () => {
    // Not a re-run of the payment rule: a check that the state which let the goods out is
    // still the state on the row.
    expect(assessCompletion(inputs({ paymentStatus: 'PARTIALLY_PAID' }))).toEqual({
      complete: false,
      blocker: 'CASH_NOT_PAID',
    });
  });

  it('completes a collected order without any delivery', () => {
    const verdict = assessCompletion(
      inputs({ deliveryRequired: false, deliveryStatus: null, pickedUp: true }),
    );
    expect(verdict).toEqual({ complete: true, blocker: null });
  });

  it('does not complete a collection order nobody has collected', () => {
    expect(
      assessCompletion(inputs({ deliveryRequired: false, deliveryStatus: null, pickedUp: false })),
    ).toEqual({ complete: false, blocker: 'PICKUP_NOT_RECORDED' });
  });

  it('does not accept a pickup as a substitute for a required delivery', () => {
    expect(
      assessCompletion(inputs({ deliveryRequired: true, deliveryStatus: null, pickedUp: true })),
    ).toEqual({ complete: false, blocker: 'DELIVERY_NOT_DELIVERED' });
  });

  it('does not complete an order with no warehouse task at all', () => {
    expect(assessCompletion(inputs({ warehouseTaskStatus: null }))).toEqual({
      complete: false,
      blocker: 'WAREHOUSE_NOT_COMPLETE',
    });
  });
});

describe('cancellation once fulfilment has begun', () => {
  it('allows cancelling an order the warehouse has not touched', () => {
    expect(assessCancellation(null).allowed).toBe(true);
    expect(assessCancellation('PENDING').allowed).toBe(true);
  });

  it('allows cancelling after the warehouse task itself was cancelled', () => {
    expect(assessCancellation('CANCELLED').allowed).toBe(true);
  });

  it('blocks cancelling while someone is picking it', () => {
    const verdict = assessCancellation('IN_PROGRESS');
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocker).toBe('WAREHOUSE_STARTED');
    // The refusal names the way out rather than being a dead end.
    expect(verdict.detail).toMatch(/Cancel the warehouse task first/);
  });

  it('blocks cancelling a picked order', () => {
    expect(assessCancellation('PREPARED').blocker).toBe('WAREHOUSE_STARTED');
  });

  it('blocks cancelling once the goods have gone, permanently', () => {
    const verdict = assessCancellation('COMPLETED');
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocker).toBe('STOCK_CONSUMED');
    // No suggestion that cancelling could put stock back, because it cannot.
    expect(verdict.detail).toMatch(/return/);
  });
});
