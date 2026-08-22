import { describe, expect, it } from 'vitest';
import {
  DISCREPANCY_RESOLUTIONS,
  DISCREPANCY_STATUSES,
  DISCREPANCY_TYPES,
  affectedByShortfall,
  assessReconciliation,
  canTransitionDiscrepancy,
  classifyVariance,
  isDiscrepancyOpen,
  shortfallLeavesOrderUnfulfillable,
} from '@/modules/inventory';
import type { ReconciliationInputs } from '@/modules/inventory';
import {
  PRISMA_DISCREPANCY_RESOLUTIONS,
  PRISMA_DISCREPANCY_STATUSES,
  PRISMA_DISCREPANCY_TYPES,
} from '../support/prisma-meta';

describe('the discrepancy state machine', () => {
  it('matches the enums in the database schema', () => {
    expect([...DISCREPANCY_STATUSES].sort()).toEqual([...PRISMA_DISCREPANCY_STATUSES].sort());
    expect([...DISCREPANCY_TYPES].sort()).toEqual([...PRISMA_DISCREPANCY_TYPES].sort());
    expect([...DISCREPANCY_RESOLUTIONS].sort()).toEqual(
      [...PRISMA_DISCREPANCY_RESOLUTIONS].sort(),
    );
  });

  it('can be resolved straight from open, without a review step', () => {
    // A manager who can see the count and the shelf should not have to click twice.
    expect(canTransitionDiscrepancy('OPEN', 'RESOLVED')).toBe(true);
    expect(canTransitionDiscrepancy('OPEN', 'UNDER_REVIEW')).toBe(true);
    expect(canTransitionDiscrepancy('UNDER_REVIEW', 'RESOLVED')).toBe(true);
  });

  it('can be handed back from review to open', () => {
    expect(canTransitionDiscrepancy('UNDER_REVIEW', 'OPEN')).toBe(true);
  });

  it('treats RESOLVED as terminal, because it records a decision somebody made', () => {
    for (const status of DISCREPANCY_STATUSES) {
      expect(canTransitionDiscrepancy('RESOLVED', status)).toBe(false);
    }
  });

  it('treats CANCELLED as terminal', () => {
    for (const status of DISCREPANCY_STATUSES) {
      expect(canTransitionDiscrepancy('CANCELLED', status)).toBe(false);
    }
  });

  it('knows which statuses still block a handover', () => {
    expect(isDiscrepancyOpen('OPEN')).toBe(true);
    expect(isDiscrepancyOpen('UNDER_REVIEW')).toBe(true);
    expect(isDiscrepancyOpen('RESOLVED')).toBe(false);
    expect(isDiscrepancyOpen('CANCELLED')).toBe(false);
  });
});

describe('classifying a count', () => {
  it('calls less than the system a shortage', () => {
    // The §4A worked example: system says 100, the shelf has 60.
    expect(classifyVariance(100, 60)).toEqual({ variance: -40, type: 'PHYSICAL_SHORTAGE' });
  });

  it('calls more than the system an overage', () => {
    expect(classifyVariance(100, 110)).toEqual({ variance: 10, type: 'PHYSICAL_OVERAGE' });
  });

  it('reports zero variance without pretending it is a shortage', () => {
    expect(classifyVariance(100, 100)).toEqual({ variance: 0, type: 'OTHER' });
  });

  it('handles an empty shelf', () => {
    expect(classifyVariance(40, 0)).toEqual({ variance: -40, type: 'PHYSICAL_SHORTAGE' });
  });
});

describe('whether a count may be written into stock', () => {
  const inputs = (overrides: Partial<ReconciliationInputs> = {}): ReconciliationInputs => ({
    status: 'UNDER_REVIEW',
    currentOnHand: 100,
    currentReserved: 0,
    physicalCount: 60,
    reportedSystemOnHand: 100,
    ...overrides,
  });

  it('applies a shortage when nothing is committed', () => {
    const verdict = assessReconciliation(inputs());
    expect(verdict.canApply).toBe(true);
    expect(verdict.delta).toBe(-40);
    expect(verdict.reservationShortfall).toBe(0);
  });

  it('applies an overage', () => {
    const verdict = assessReconciliation(inputs({ physicalCount: 110 }));
    expect(verdict.canApply).toBe(true);
    expect(verdict.delta).toBe(10);
  });

  it('refuses to resolve twice', () => {
    // The database enforces this with a trigger as well. A double-applied correction is a
    // silent double adjustment, which is the worst possible failure of a stock ledger.
    const verdict = assessReconciliation(inputs({ status: 'RESOLVED' }));
    expect(verdict.canApply).toBe(false);
    expect(verdict.refusal).toBe('ALREADY_RESOLVED');
    expect(verdict.delta).toBe(0);
  });

  it('refuses on a cancelled discrepancy', () => {
    expect(assessReconciliation(inputs({ status: 'CANCELLED' })).refusal).toBe('CANCELLED');
  });

  it('refuses when stock has moved since the count was taken', () => {
    // The count was against 100 and the system now says 90 — a shipment landed in between.
    // Applying a delta computed from the old baseline would write a number nobody counted.
    const verdict = assessReconciliation(inputs({ currentOnHand: 90 }));
    expect(verdict.canApply).toBe(false);
    expect(verdict.refusal).toBe('STOCK_MOVED_SINCE_REPORT');
    expect(verdict.detail).toMatch(/Count again/);
  });

  it('resolves without change when the recount agrees', () => {
    const verdict = assessReconciliation(inputs({ physicalCount: 100 }));
    expect(verdict.canApply).toBe(false);
    expect(verdict.refusal).toBe('NOTHING_TO_CHANGE');
    expect(verdict.delta).toBe(0);
  });

  it('refuses when the verified count cannot cover what is committed', () => {
    // The §11 case: on-hand 100, reserved 80, counted 60. Persisting 60 would leave
    // available < reserved, which the database refuses and which promises goods that do not
    // exist.
    const verdict = assessReconciliation(inputs({ currentReserved: 80, physicalCount: 60 }));
    expect(verdict.canApply).toBe(false);
    expect(verdict.refusal).toBe('RESERVATION_SHORTFALL');
    expect(verdict.reservationShortfall).toBe(20);
    expect(verdict.detail).toContain('20');
  });

  it('allows a count that exactly covers the committed stock', () => {
    // 80 committed, 80 counted. Tight, and legal — nothing is over-promised.
    const verdict = assessReconciliation(inputs({ currentReserved: 80, physicalCount: 80 }));
    expect(verdict.canApply).toBe(true);
    expect(verdict.delta).toBe(-20);
  });

  it('never proposes shrinking a reservation on its own', () => {
    // The shortfall is reported, not acted on. Which customer gives way is a commercial
    // decision, and a reconciliation that quietly took stock back from an order would be making
    // it while appearing to do arithmetic.
    const verdict = assessReconciliation(inputs({ currentReserved: 80, physicalCount: 60 }));
    expect(verdict.canApply).toBe(false);
    expect(verdict.reservationShortfall).toBeGreaterThan(0);
  });

  it('reports the stale-baseline refusal before the shortfall one', () => {
    // If the figures moved, the count itself is untrustworthy — telling somebody to go and
    // negotiate with a customer over a stale number would be worse than useless.
    const verdict = assessReconciliation(
      inputs({ currentOnHand: 90, currentReserved: 80, physicalCount: 60 }),
    );
    expect(verdict.refusal).toBe('STOCK_MOVED_SINCE_REPORT');
  });
});

describe('surfacing the affected orders', () => {
  const reservation = (orderNumber: string, quantity: number, days: number) => ({
    reservationId: `r-${orderNumber}`,
    salesOrderId: `o-${orderNumber}`,
    orderNumber,
    customerName: `Customer ${orderNumber}`,
    quantity,
    createdAt: new Date(Date.UTC(2026, 0, days)),
  });

  it('applies no ranking of any kind', () => {
    // The property that matters. Sorted by order number, which is to say by nothing meaningful:
    // not oldest first, not largest first, not by customer value, and not by a model. Deciding
    // who does not get their cement is a conversation, and a pre-sorted list would be making
    // that decision while appearing merely to display information.
    const input = [
      reservation('SO-000003', 10, 3),
      reservation('SO-000001', 90, 1),
      reservation('SO-000002', 50, 2),
    ];
    const result = affectedByShortfall(input, 20);

    expect(result.reservations.map((entry) => entry.orderNumber)).toEqual([
      'SO-000001',
      'SO-000002',
      'SO-000003',
    ]);
    // Explicitly not by quantity, and explicitly not by age.
    expect(result.reservations[0]!.quantity).not.toBe(10);
  });

  it('reports the total committed alongside the shortfall', () => {
    const result = affectedByShortfall(
      [reservation('SO-000001', 50, 1), reservation('SO-000002', 30, 2)],
      20,
    );
    expect(result.totalCommitted).toBe(80);
    expect(result.shortfall).toBe(20);
  });

  it('does not mutate the list it was given', () => {
    const input = [reservation('SO-000002', 10, 2), reservation('SO-000001', 10, 1)];
    affectedByShortfall(input, 5);
    expect(input[0]!.orderNumber).toBe('SO-000002');
  });
});

describe('what a reduced reservation does to an order', () => {
  it('leaves the order unfulfillable when it no longer holds what it needs', () => {
    const verdict = shortfallLeavesOrderUnfulfillable(80, 60);
    expect(verdict).toEqual({ unfulfillable: true, shortfall: 20 });
  });

  it('is satisfied when the reservation still covers the requirement', () => {
    expect(shortfallLeavesOrderUnfulfillable(80, 80)).toEqual({
      unfulfillable: false,
      shortfall: 0,
    });
  });

  it('treats a fully released reservation as the whole requirement short', () => {
    expect(shortfallLeavesOrderUnfulfillable(80, 0)).toEqual({
      unfulfillable: true,
      shortfall: 80,
    });
  });

  it('never reports a negative shortfall', () => {
    // An over-reserved order is a different problem, and it is not this function's to invent.
    expect(shortfallLeavesOrderUnfulfillable(80, 100).shortfall).toBe(0);
  });
});
