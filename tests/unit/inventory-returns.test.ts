import { describe, expect, it } from 'vitest';
import {
  FAILURE_RESOLUTIONS,
  RETURN_DISPOSITIONS,
  RETURN_REASONS,
  RETURN_STATUSES,
  accountFor,
  assessInspection,
  assessRetryEligibility,
  canTransitionReturn,
  isReturnOpen,
  restockEffect,
} from '@/modules/inventory';
import type { InspectionInput, RetryEligibility } from '@/modules/inventory';
import {
  PRISMA_DELIVERY_FAILURE_RESOLUTIONS,
  PRISMA_RETURN_DISPOSITIONS,
  PRISMA_RETURN_REASONS,
  PRISMA_RETURN_STATUSES,
} from '../support/prisma-meta';

describe('the return state machine', () => {
  it('matches the enums in the database schema', () => {
    expect([...RETURN_STATUSES].sort()).toEqual([...PRISMA_RETURN_STATUSES].sort());
    expect([...RETURN_REASONS].sort()).toEqual([...PRISMA_RETURN_REASONS].sort());
    expect([...RETURN_DISPOSITIONS].sort()).toEqual([...PRISMA_RETURN_DISPOSITIONS].sort());
    expect([...FAILURE_RESOLUTIONS].sort()).toEqual(
      [...PRISMA_DELIVERY_FAILURE_RESOLUTIONS].sort(),
    );
  });

  it('walks expected to completed one step at a time', () => {
    expect(canTransitionReturn('EXPECTED', 'RECEIVED')).toBe(true);
    expect(canTransitionReturn('RECEIVED', 'INSPECTED')).toBe(true);
    expect(canTransitionReturn('INSPECTED', 'COMPLETED')).toBe(true);
  });

  it('refuses to restock goods nobody counted', () => {
    // COMPLETED is the moment stock goes back on the shelf. Reaching it without an inspection
    // would put an uncounted quantity into inventory.
    expect(canTransitionReturn('EXPECTED', 'COMPLETED')).toBe(false);
    expect(canTransitionReturn('RECEIVED', 'COMPLETED')).toBe(false);
    expect(canTransitionReturn('EXPECTED', 'INSPECTED')).toBe(false);
  });

  it('treats COMPLETED as terminal, because there is no un-restocking', () => {
    for (const status of RETURN_STATUSES) {
      expect(canTransitionReturn('COMPLETED', status)).toBe(false);
    }
  });

  it('can be withdrawn right up to the point stock moves', () => {
    expect(canTransitionReturn('EXPECTED', 'CANCELLED')).toBe(true);
    expect(canTransitionReturn('RECEIVED', 'CANCELLED')).toBe(true);
    expect(canTransitionReturn('INSPECTED', 'CANCELLED')).toBe(true);
    expect(canTransitionReturn('COMPLETED', 'CANCELLED')).toBe(false);
  });

  it('never allows a status to transition to itself', () => {
    for (const status of RETURN_STATUSES) {
      expect(canTransitionReturn(status, status)).toBe(false);
    }
  });

  it('knows which statuses are still live', () => {
    expect(isReturnOpen('EXPECTED')).toBe(true);
    expect(isReturnOpen('RECEIVED')).toBe(true);
    expect(isReturnOpen('INSPECTED')).toBe(true);
    expect(isReturnOpen('COMPLETED')).toBe(false);
    expect(isReturnOpen('CANCELLED')).toBe(false);
  });
});

describe('inspecting a returned line', () => {
  const input = (overrides: Partial<InspectionInput> = {}): InspectionInput => ({
    quantityDispatched: 80,
    quantityExpected: 80,
    quantityReceived: 80,
    quantityRestockable: 76,
    quantityDamaged: 4,
    ...overrides,
  });

  it('accepts the worked example: 80 out, 76 sellable, 4 damaged', () => {
    const verdict = assessInspection(input());
    expect(verdict.valid).toBe(true);
    expect(verdict.quantityMissing).toBe(0);
    expect(verdict.disposition).toBe('MIXED');
  });

  it('accepts a whole load coming back intact', () => {
    const verdict = assessInspection(input({ quantityRestockable: 80, quantityDamaged: 0 }));
    expect(verdict.valid).toBe(true);
    expect(verdict.disposition).toBe('RESTOCK');
    expect(verdict.quantityMissing).toBe(0);
  });

  it('derives what is missing rather than taking somebody word for it', () => {
    // 80 expected, 78 arrived. The two that did not are missing — derived, so the invariant
    // cannot be satisfied by adjusting the wrong number.
    const verdict = assessInspection(
      input({ quantityReceived: 78, quantityRestockable: 78, quantityDamaged: 0 }),
    );
    expect(verdict.valid).toBe(true);
    expect(verdict.quantityMissing).toBe(2);
    expect(verdict.disposition).toBe('MIXED');
  });

  it('calls a wholly broken load damaged', () => {
    const verdict = assessInspection(input({ quantityRestockable: 0, quantityDamaged: 80 }));
    expect(verdict.disposition).toBe('DAMAGED');
  });

  it('calls a load that never arrived missing', () => {
    const verdict = assessInspection(
      input({ quantityReceived: 0, quantityRestockable: 0, quantityDamaged: 0 }),
    );
    expect(verdict.valid).toBe(true);
    expect(verdict.quantityMissing).toBe(80);
    expect(verdict.disposition).toBe('MISSING');
  });

  it('refuses a split that does not add up', () => {
    // 80 came back but only 70 were accounted for. Ten units would have vanished from history.
    const verdict = assessInspection(input({ quantityRestockable: 66, quantityDamaged: 4 }));
    expect(verdict.valid).toBe(false);
    expect(verdict.problem).toBe('SPLIT_DOES_NOT_SUM');
    expect(verdict.detail).toContain('80');
    expect(verdict.detail).toContain('70');
  });

  it('refuses to expect back more than went out', () => {
    const verdict = assessInspection(input({ quantityExpected: 90 }));
    expect(verdict.valid).toBe(false);
    expect(verdict.problem).toBe('EXCEEDS_DISPATCHED');
  });

  it('refuses to receive more than was expected', () => {
    // A lorry cannot bring back goods it never carried.
    const verdict = assessInspection(
      input({ quantityExpected: 70, quantityReceived: 80, quantityRestockable: 76 }),
    );
    expect(verdict.valid).toBe(false);
    expect(verdict.problem).toBe('EXCEEDS_EXPECTED');
  });

  it('refuses negative quantities', () => {
    expect(assessInspection(input({ quantityDamaged: -4 })).problem).toBe('NEGATIVE_QUANTITY');
  });
});

describe('what a completed return puts back', () => {
  it('restocks only the sellable portion', () => {
    // The property this whole workflow turns on. Damaged goods are physically present and
    // commercially worthless; putting them on available_stock would offer a customer a broken
    // bag of cement.
    const effect = restockEffect([
      { productId: 'p1', quantityRestockable: 76 },
      { productId: 'p2', quantityRestockable: 0 },
    ]);
    expect(effect.get('p1')).toBe(76);
    expect(effect.has('p2')).toBe(false);
  });

  it('sums two lines naming the same product', () => {
    const effect = restockEffect([
      { productId: 'p1', quantityRestockable: 10 },
      { productId: 'p1', quantityRestockable: 5 },
    ]);
    expect(effect.get('p1')).toBe(15);
  });

  it('restocks nothing from a wholly damaged load', () => {
    expect(restockEffect([{ productId: 'p1', quantityRestockable: 0 }]).size).toBe(0);
  });
});

describe('accounting for every unit that left', () => {
  it('accounts for the worked example without losing anything', () => {
    const totals = accountFor([
      { quantityDispatched: 80, quantityRestockable: 76, quantityDamaged: 4, quantityMissing: 0 },
    ]);
    expect(totals).toEqual({
      dispatched: 80,
      restocked: 76,
      damaged: 4,
      missing: 0,
      unaccounted: 0,
    });
  });

  it('reports what stayed with the customer as unaccounted, not as lost', () => {
    // A partly returned load is legitimate: the customer kept 30. Not an error, and still a
    // number worth being able to see rather than one that quietly disappears.
    const totals = accountFor([
      { quantityDispatched: 80, quantityRestockable: 50, quantityDamaged: 0, quantityMissing: 0 },
    ]);
    expect(totals.unaccounted).toBe(30);
  });

  it('keeps damaged and missing separate', () => {
    const totals = accountFor([
      { quantityDispatched: 80, quantityRestockable: 60, quantityDamaged: 15, quantityMissing: 5 },
    ]);
    expect(totals.damaged).toBe(15);
    expect(totals.missing).toBe(5);
    expect(totals.unaccounted).toBe(0);
  });
});

describe('whether a failed delivery may be retried', () => {
  const inputs = (overrides: Partial<RetryEligibility> = {}): RetryEligibility => ({
    deliveryStatus: 'FAILED',
    existingResolution: null,
    goodsRestocked: false,
    hasLiveRetry: false,
    orderStatus: 'OPEN',
    ...overrides,
  });

  it('allows a retry while the goods are still on the lorry', () => {
    expect(assessRetryEligibility(inputs())).toMatchObject({ eligible: true, refusal: null });
  });

  it('refuses to retry a delivery that has not failed', () => {
    for (const status of ['PENDING', 'ASSIGNED', 'DISPATCHED', 'DELIVERED'] as const) {
      expect(assessRetryEligibility(inputs({ deliveryStatus: status })).refusal).toBe('NOT_FAILED');
    }
  });

  it('refuses once the goods are back on the shelf', () => {
    // The §23 rule. Once a return has restocked them, the units are counted as inventory again;
    // dispatching without consuming stock would ship goods the system still believes are here.
    const verdict = assessRetryEligibility(inputs({ goodsRestocked: true }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.refusal).toBe('GOODS_BACK_IN_WAREHOUSE');
    // The refusal says what to do instead rather than being a dead end.
    expect(verdict.detail).toMatch(/through the warehouse/);
  });

  it('refuses a second retry of the same attempt', () => {
    // A double-clicked button would otherwise put two vehicles on the road for one shipment.
    expect(assessRetryEligibility(inputs({ hasLiveRetry: true })).refusal).toBe(
      'RETRY_ALREADY_EXISTS',
    );
  });

  it('refuses when the failure was already written off', () => {
    expect(
      assessRetryEligibility(inputs({ existingResolution: 'LOST_OR_UNRECOVERABLE' })).refusal,
    ).toBe('ALREADY_RESOLVED');
  });

  it('refuses when the order is no longer open', () => {
    for (const status of ['CANCELLED', 'COMPLETED'] as const) {
      expect(assessRetryEligibility(inputs({ orderStatus: status })).refusal).toBe(
        'ORDER_NOT_OPEN',
      );
    }
  });

  it('reports the restocked refusal before the duplicate-retry one', () => {
    // Both are true in this state, and only one of them explains what actually has to happen.
    const verdict = assessRetryEligibility(inputs({ goodsRestocked: true, hasLiveRetry: true }));
    expect(verdict.refusal).toBe('GOODS_BACK_IN_WAREHOUSE');
  });
});
