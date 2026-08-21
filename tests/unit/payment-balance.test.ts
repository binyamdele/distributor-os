import { describe, expect, it } from 'vitest';
import { paymentStatusFor, summariseBalance } from '@/modules/payments/balance';
import {
  DUE_SOON_DAYS,
  bucketFor,
  daysOverdue,
  prioritise,
  aggregateByCustomer,
  type ReceivableRow,
} from '@/modules/payments/receivables';
import { canTransition, creditIsDue, isReviewable, PAYMENT_STATUSES } from '@/modules/payments';
import type { PaymentStatus } from '@/modules/payments';

const ETB = 'ETB';
const etb = (major: number, minor = 0): bigint => BigInt(major) * 100n + BigInt(minor);

describe('order balance', () => {
  it('is the total when nothing is confirmed', () => {
    const summary = summariseBalance(etb(487_300), [], ETB);
    expect(summary.confirmedMinor).toBe(0n);
    expect(summary.outstandingMinor).toBe(etb(487_300));
    expect(summary.state).toBe('UNPAID');
    expect(summary.fullySettled).toBe(false);
  });

  it('is zero when settled exactly', () => {
    const summary = summariseBalance(etb(487_300), [{ amountConfirmedMinor: etb(487_300) }], ETB);
    expect(summary.outstandingMinor).toBe(0n);
    expect(summary.overpaidMinor).toBe(0n);
    expect(summary.state).toBe('PAID');
    expect(summary.fullySettled).toBe(true);
  });

  it('reports the remainder on a partial payment', () => {
    const summary = summariseBalance(etb(500_000), [{ amountConfirmedMinor: etb(300_000) }], ETB);
    expect(summary.confirmedMinor).toBe(etb(300_000));
    expect(summary.outstandingMinor).toBe(etb(200_000));
    expect(summary.state).toBe('PARTIALLY_PAID');
    expect(summary.fullySettled).toBe(false);
  });

  it('adds up a split payment', () => {
    const summary = summariseBalance(
      etb(500_000),
      [{ amountConfirmedMinor: etb(300_000) }, { amountConfirmedMinor: etb(200_000) }],
      ETB,
    );
    expect(summary.outstandingMinor).toBe(0n);
    expect(summary.state).toBe('PAID');
    expect(summary.fullySettled).toBe(true);
  });

  it('surfaces an overpayment rather than absorbing it', () => {
    // Losing the difference would be worse than showing it. There is no refund flow yet, and
    // pretending the money did not arrive would be a lie in the customer's favour or ours.
    const summary = summariseBalance(etb(500_000), [{ amountConfirmedMinor: etb(520_000) }], ETB);
    expect(summary.outstandingMinor).toBe(0n);
    expect(summary.overpaidMinor).toBe(etb(20_000));
    expect(summary.state).toBe('OVERPAID');
    expect(summary.fullySettled).toBe(true);
  });

  it('never reports a negative outstanding', () => {
    const summary = summariseBalance(etb(100), [{ amountConfirmedMinor: etb(999) }], ETB);
    expect(summary.outstandingMinor).toBe(0n);
    expect(summary.outstandingMinor).toBeGreaterThanOrEqual(0n);
  });

  it('works in santim, not floats', () => {
    // Three payments of 33.33 against 100.00 leaves exactly one santim.
    const summary = summariseBalance(
      etb(100),
      [
        { amountConfirmedMinor: etb(33, 33) },
        { amountConfirmedMinor: etb(33, 33) },
        { amountConfirmedMinor: etb(33, 33) },
      ],
      ETB,
    );
    expect(summary.outstandingMinor).toBe(1n);
  });

  it('survives amounts beyond float precision', () => {
    const huge = 10_000_000_000_000_01n;
    const summary = summariseBalance(huge, [{ amountConfirmedMinor: 1n }], ETB);
    expect(summary.outstandingMinor).toBe(huge - 1n);
  });

  it('refuses a negative order total', () => {
    expect(() => summariseBalance(-1n, [], ETB)).toThrow(/negative/);
  });
});

describe('the order payment status a balance implies', () => {
  const unpaid = summariseBalance(etb(1_000), [], ETB);
  const partial = summariseBalance(etb(1_000), [{ amountConfirmedMinor: etb(400) }], ETB);
  const paid = summariseBalance(etb(1_000), [{ amountConfirmedMinor: etb(1_000) }], ETB);

  it('is UNPAID for an untouched cash order', () => {
    expect(paymentStatusFor(unpaid, 'CASH', false)).toBe('UNPAID');
  });

  it('is PARTIALLY_PAID once something has been confirmed', () => {
    expect(paymentStatusFor(partial, 'CASH', false)).toBe('PARTIALLY_PAID');
  });

  it('is PAID when settled', () => {
    expect(paymentStatusFor(paid, 'CASH', false)).toBe('PAID');
  });

  it('leaves a credit order NOT_REQUIRED_YET before its due date', () => {
    expect(paymentStatusFor(unpaid, 'CREDIT', false)).toBe('NOT_REQUIRED_YET');
  });

  it('calls a credit order UNPAID once the due date has passed', () => {
    // Continuing to say "not required yet" after the date would hide a receivable from the
    // people whose job is to chase it.
    expect(paymentStatusFor(unpaid, 'CREDIT', true)).toBe('UNPAID');
  });

  it('reports a part-paid credit order as PARTIALLY_PAID whether or not it is due', () => {
    expect(paymentStatusFor(partial, 'CREDIT', false)).toBe('PARTIALLY_PAID');
    expect(paymentStatusFor(partial, 'CREDIT', true)).toBe('PARTIALLY_PAID');
  });

  it('treats an overpaid order as paid', () => {
    const over = summariseBalance(etb(1_000), [{ amountConfirmedMinor: etb(1_200) }], ETB);
    expect(paymentStatusFor(over, 'CASH', false)).toBe('PAID');
  });
});

describe('credit due dates', () => {
  const due = new Date('2026-08-20T00:00:00.000Z');

  it('is not due before the date', () => {
    expect(creditIsDue(due, new Date('2026-08-19T23:00:00.000Z'))).toBe(false);
  });

  it('is not due on the day itself', () => {
    expect(creditIsDue(due, new Date('2026-08-20T23:00:00.000Z'))).toBe(false);
  });

  it('is due the day after', () => {
    expect(creditIsDue(due, new Date('2026-08-21T00:00:01.000Z'))).toBe(true);
  });

  it('is never due without a date', () => {
    expect(creditIsDue(null)).toBe(false);
  });
});

describe('receivable buckets', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');

  it('classifies by the due date', () => {
    expect(bucketFor(new Date('2026-08-04T00:00:00.000Z'), now)).toBe('OVERDUE');
    expect(bucketFor(new Date('2026-08-21T00:00:00.000Z'), now)).toBe('DUE_TODAY');
    expect(bucketFor(new Date('2026-08-22T00:00:00.000Z'), now)).toBe('DUE_SOON');
    expect(bucketFor(new Date('2026-09-30T00:00:00.000Z'), now)).toBe('NOT_DUE');
  });

  it('treats the last day of the due-soon window as due soon', () => {
    const edge = new Date(now.getTime());
    edge.setUTCDate(edge.getUTCDate() + DUE_SOON_DAYS);
    expect(bucketFor(edge, now)).toBe('DUE_SOON');
  });

  it('treats a cash order with no due date as not due', () => {
    expect(bucketFor(null, now)).toBe('NOT_DUE');
  });

  it('counts days overdue and never goes negative', () => {
    expect(daysOverdue(new Date('2026-08-04T00:00:00.000Z'), now)).toBe(17);
    expect(daysOverdue(new Date('2026-08-21T00:00:00.000Z'), now)).toBe(0);
    expect(daysOverdue(new Date('2026-09-30T00:00:00.000Z'), now)).toBe(0);
    expect(daysOverdue(null, now)).toBe(0);
  });
});

function receivable(overrides: Partial<ReceivableRow> = {}): ReceivableRow {
  return {
    orderId: 'order-1',
    orderNumber: 'SO-000001',
    customerId: 'customer-1',
    customerName: 'ABC Construction',
    customerPhone: null,
    currency: ETB,
    orderTotalMinor: etb(100_000),
    confirmedMinor: 0n,
    outstandingMinor: etb(100_000),
    dueDate: new Date('2026-08-01T00:00:00.000Z'),
    bucket: 'OVERDUE',
    daysOverdue: 5,
    paymentTermsDays: 30,
    paymentType: 'CREDIT',
    ownerId: null,
    ...overrides,
  };
}

describe('collections priority', () => {
  it('puts overdue first', () => {
    const sorted = prioritise([
      receivable({ orderNumber: 'SO-2', bucket: 'NOT_DUE', daysOverdue: 0 }),
      receivable({ orderNumber: 'SO-1', bucket: 'OVERDUE', daysOverdue: 3 }),
    ]);
    expect(sorted.map((row) => row.orderNumber)).toEqual(['SO-1', 'SO-2']);
  });

  it('then sorts by how long overdue', () => {
    const sorted = prioritise([
      receivable({ orderNumber: 'SO-A', daysOverdue: 8 }),
      receivable({ orderNumber: 'SO-B', daysOverdue: 17 }),
    ]);
    expect(sorted.map((row) => row.orderNumber)).toEqual(['SO-B', 'SO-A']);
  });

  it('then by the larger outstanding balance', () => {
    const sorted = prioritise([
      receivable({ orderNumber: 'SO-A', daysOverdue: 5, outstandingMinor: etb(180_000) }),
      receivable({ orderNumber: 'SO-B', daysOverdue: 5, outstandingMinor: etb(340_000) }),
    ]);
    expect(sorted.map((row) => row.orderNumber)).toEqual(['SO-B', 'SO-A']);
  });

  it('reproduces the brief’s worked example', () => {
    const sorted = prioritise([
      receivable({ orderNumber: 'C', customerName: 'Company C', bucket: 'DUE_SOON', daysOverdue: 0, outstandingMinor: etb(620_000) }),
      receivable({ orderNumber: 'B', customerName: 'Company B', daysOverdue: 8, outstandingMinor: etb(180_000) }),
      receivable({ orderNumber: 'A', customerName: 'XYZ Trading', daysOverdue: 17, outstandingMinor: etb(340_000) }),
    ]);
    // XYZ 17 days, Company B 8 days, then Company C which is not yet overdue at all.
    expect(sorted.map((row) => row.customerName)).toEqual([
      'XYZ Trading',
      'Company B',
      'Company C',
    ]);
  });

  it('is deterministic on a complete tie', () => {
    const sorted = prioritise([
      receivable({ orderNumber: 'SO-000002' }),
      receivable({ orderNumber: 'SO-000001' }),
    ]);
    expect(sorted.map((row) => row.orderNumber)).toEqual(['SO-000001', 'SO-000002']);
  });
});

describe('customer aggregate', () => {
  it('sums outstanding across a customer’s orders', () => {
    const rows = aggregateByCustomer([
      receivable({ orderNumber: 'SO-1', outstandingMinor: etb(100_000) }),
      receivable({ orderNumber: 'SO-2', outstandingMinor: etb(50_000), bucket: 'NOT_DUE' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outstandingMinor).toBe(etb(150_000));
    expect(rows[0]!.orderCount).toBe(2);
    // Only the overdue slice counts as overdue.
    expect(rows[0]!.overdueMinor).toBe(etb(100_000));
  });

  it('keeps customers apart and sorts by size', () => {
    const rows = aggregateByCustomer([
      receivable({ customerId: 'a', customerName: 'Small', outstandingMinor: etb(10) }),
      receivable({ customerId: 'b', customerName: 'Large', outstandingMinor: etb(900) }),
    ]);
    expect(rows.map((row) => row.customerName)).toEqual(['Large', 'Small']);
  });
});

describe('the payment state machine', () => {
  it('permits exactly the documented transitions', () => {
    const expected: Record<PaymentStatus, PaymentStatus[]> = {
      SUBMITTED: ['NEEDS_REVIEW', 'CONFIRMED', 'REJECTED'],
      NEEDS_REVIEW: ['CONFIRMED', 'REJECTED'],
      CONFIRMED: [],
      REJECTED: [],
    };

    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected[from].includes(to));
      }
    }
  });

  it('treats a decided payment as final', () => {
    // Correcting confirmed money in place would rewrite what Finance put their name to.
    expect(canTransition('CONFIRMED', 'REJECTED')).toBe(false);
    expect(canTransition('REJECTED', 'CONFIRMED')).toBe(false);
    expect(isReviewable('CONFIRMED')).toBe(false);
    expect(isReviewable('REJECTED')).toBe(false);
  });

  it('knows which statuses still await a decision', () => {
    expect(isReviewable('SUBMITTED')).toBe(true);
    expect(isReviewable('NEEDS_REVIEW')).toBe(true);
  });
});
