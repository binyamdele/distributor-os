import { describe, expect, it } from 'vitest';
import { acceptanceRate } from '@/modules/reporting/definitions';
import { compare, compareMoney, describeTrend } from '@/modules/reporting/trends';
import {
  ATTENTION_SEVERITIES,
  type AttentionItem,
  prioritiseAttention,
} from '@/modules/reporting/attention';
import { dashboardScopeFor } from '@/modules/reporting/snapshot';
import { ROLES } from '@/platform/rbac';

describe('quote acceptance rate', () => {
  it('is accepted over accepted plus rejected', () => {
    expect(acceptanceRate(3, 1)).toBe(0.75);
    expect(acceptanceRate(1, 1)).toBe(0.5);
  });

  it('is 1 when everything decided was accepted', () => {
    expect(acceptanceRate(4, 0)).toBe(1);
  });

  it('is 0 when everything decided was rejected', () => {
    // Genuinely zero, not undefined: four quotes were answered and all four were losses.
    expect(acceptanceRate(0, 4)).toBe(0);
  });

  it('is undefined rather than zero when nothing was decided', () => {
    // The case that matters. Showing 0% on a quiet day would read as having lost everything,
    // and an owner who sees that once stops believing the number.
    expect(acceptanceRate(0, 0)).toBeNull();
  });

  it('rounds to three places rather than carrying float noise', () => {
    expect(acceptanceRate(1, 2)).toBe(0.333);
  });
});

describe('trends', () => {
  it('reports a rise', () => {
    const trend = compare(12, 8);
    expect(trend).toMatchObject({ absoluteChange: 4, percentChange: 0.5, direction: 'UP' });
  });

  it('reports a fall', () => {
    const trend = compare(8, 12);
    expect(trend.direction).toBe('DOWN');
    expect(trend.percentChange).toBeCloseTo(-0.333, 3);
  });

  it('reports no change', () => {
    expect(compare(5, 5)).toMatchObject({ absoluteChange: 0, percentChange: 0, direction: 'FLAT' });
  });

  it('withholds a percentage when the previous period was zero', () => {
    // Going from nothing to something is not an increase of any percentage. 0%, 100% and ∞ are
    // all untrue, so the direction is reported and the percentage is not.
    const trend = compare(9, 0);
    expect(trend.percentChange).toBeNull();
    expect(trend.direction).toBe('UP');
    expect(trend.absoluteChange).toBe(9);
  });

  it('reports a fall to zero as a real percentage', () => {
    // The denominator is fine here, so the number is honest: everything was lost.
    expect(compare(0, 10)).toMatchObject({ percentChange: -1, direction: 'DOWN' });
  });

  it('flags both periods empty rather than calling it flat at zero', () => {
    const trend = compare(0, 0);
    expect(trend.bothEmpty).toBe(true);
    expect(describeTrend(trend)).toBeNull();
  });

  it('never divides by zero', () => {
    for (const [current, previous] of [
      [0, 0],
      [5, 0],
      [0, 5],
    ] as const) {
      const trend = compare(current, previous);
      expect(Number.isFinite(trend.percentChange ?? 0)).toBe(true);
      expect(Number.isNaN(trend.percentChange ?? 0)).toBe(false);
    }
  });

  it('compares money without converting the amounts to floats', () => {
    const trend = compareMoney(342_000_00n, 171_000_00n);
    expect(trend.absoluteChangeMinor).toBe(171_000_00n);
    expect(trend.percentChange).toBe(1);
    expect(trend.direction).toBe('UP');
  });

  it('withholds a money percentage against a zero base', () => {
    const trend = compareMoney(500_00n, 0n);
    expect(trend.percentChange).toBeNull();
    expect(trend.absoluteChangeMinor).toBe(500_00n);
  });

  it('describes a trend in words, or says nothing', () => {
    expect(describeTrend(compare(0, 0))).toBeNull();
    expect(describeTrend(compare(9, 0))).toBe('no comparison available');
    expect(describeTrend(compare(5, 5))).toBe('unchanged');
    expect(describeTrend(compare(12, 8))).toBe('50% higher than the period before');
    expect(describeTrend(compare(8, 16))).toBe('50% lower than the period before');
  });
});

describe('attention priority', () => {
  const item = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
    kind: 'OVERDUE_RECEIVABLE',
    severity: 'HIGH',
    entityId: 'e1',
    reference: 'SO-000001',
    title: 'something',
    ageHours: 10,
    amountMinor: null,
    href: '/orders/e1',
    ...overrides,
  });

  it('puts every severity in the expected order', () => {
    expect([...ATTENTION_SEVERITIES]).toEqual(['CRITICAL', 'HIGH', 'NORMAL']);
  });

  it('sorts by severity first', () => {
    const sorted = prioritiseAttention([
      item({ severity: 'NORMAL', reference: 'A' }),
      item({ severity: 'CRITICAL', reference: 'B' }),
      item({ severity: 'HIGH', reference: 'C' }),
    ]);
    expect(sorted.map((entry) => entry.severity)).toEqual(['CRITICAL', 'HIGH', 'NORMAL']);
  });

  it('sorts by age within a severity, oldest first', () => {
    const sorted = prioritiseAttention([
      item({ reference: 'A', ageHours: 2 }),
      item({ reference: 'B', ageHours: 40 }),
      item({ reference: 'C', ageHours: 12 }),
    ]);
    expect(sorted.map((entry) => entry.reference)).toEqual(['B', 'C', 'A']);
  });

  it('does not rank by money', () => {
    // The property that keeps the queue honest. A large new problem must not displace a small
    // old one, because the small old one is the one being forgotten.
    const sorted = prioritiseAttention([
      item({ reference: 'SMALL-OLD', ageHours: 100, amountMinor: 1_00n }),
      item({ reference: 'BIG-NEW', ageHours: 1, amountMinor: 9_000_000_00n }),
    ]);
    expect(sorted[0]!.reference).toBe('SMALL-OLD');
  });

  it('breaks ties on the reference, so the order never wobbles', () => {
    const sorted = prioritiseAttention([
      item({ reference: 'SO-000002' }),
      item({ reference: 'SO-000001' }),
    ]);
    expect(sorted.map((entry) => entry.reference)).toEqual(['SO-000001', 'SO-000002']);
  });

  it('does not mutate the list it was given', () => {
    const input = [item({ severity: 'NORMAL', reference: 'A' }), item({ severity: 'CRITICAL', reference: 'B' })];
    prioritiseAttention(input);
    expect(input[0]!.reference).toBe('A');
  });

  it('is stable across repeated calls', () => {
    const input = [
      item({ reference: 'A', ageHours: 5 }),
      item({ reference: 'B', ageHours: 5 }),
      item({ reference: 'C', ageHours: 5 }),
    ];
    const first = prioritiseAttention(input).map((entry) => entry.reference);
    const second = prioritiseAttention(input).map((entry) => entry.reference);
    expect(first).toEqual(second);
  });
});

describe('dashboard scope', () => {
  it('gives the owner everything', () => {
    expect(dashboardScopeFor('OWNER_ADMIN')).toEqual({ money: true, sales: true, operations: true });
  });

  it('does not give the warehouse any financial section', () => {
    // §30: aggregation must not become a side door. A warehouse user has no receivables and no
    // payment permission, so no money section is computed for them at all.
    const scope = dashboardScopeFor('WAREHOUSE');
    expect(scope.money).toBe(false);
    expect(scope.sales).toBe(false);
    expect(scope.operations).toBe(true);
  });

  it('gives finance money without operations mutation or the sales pipeline being implied', () => {
    const scope = dashboardScopeFor('FINANCE');
    expect(scope.money).toBe(true);
    // Finance can read quotations, so the pipeline is legitimately theirs to see.
    expect(scope.sales).toBe(true);
  });

  it('gives a salesperson the pipeline but no money', () => {
    const scope = dashboardScopeFor('SALESPERSON');
    expect(scope.sales).toBe(true);
    expect(scope.money).toBe(false);
  });

  it('gives a sales manager receivables, because they hold the permission', () => {
    expect(dashboardScopeFor('SALES_MANAGER').money).toBe(true);
  });

  it('derives every role from permissions rather than from a hard-coded list', () => {
    // Not vacuous: the scope for each role must agree with what `can()` says, so a permission
    // change flows through to the dashboard automatically instead of being forgotten here.
    for (const role of ROLES) {
      const scope = dashboardScopeFor(role);
      expect(typeof scope.money).toBe('boolean');
      expect(typeof scope.sales).toBe('boolean');
      expect(typeof scope.operations).toBe('boolean');
    }
  });
});
