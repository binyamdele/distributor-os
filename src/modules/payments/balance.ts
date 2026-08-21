import { type Money, money, subtract, sum } from '@/platform/money';

/**
 * Order balance arithmetic.
 *
 * Pure, integer, and derived — never stored as a typed figure and never read from an AI. The
 * outstanding amount on an order is always:
 *
 *     order total − Σ CONFIRMED payments
 *
 * Only `CONFIRMED` payments count. A submitted or rejected payment is a claim, and a claim that
 * reduced a balance would let anyone with the submit permission make an order look settled.
 */

export interface ConfirmedPayment {
  readonly amountConfirmedMinor: bigint;
}

export type SettlementState =
  /** Nothing confirmed. */
  | 'UNPAID'
  /** Something confirmed, but less than the total. */
  | 'PARTIALLY_PAID'
  /** Exactly settled. */
  | 'PAID'
  /** Settled and then some. The surplus is surfaced, never absorbed. */
  | 'OVERPAID';

export interface BalanceSummary {
  readonly currency: string;
  readonly orderTotalMinor: bigint;
  readonly confirmedMinor: bigint;
  /** Never negative: an overpaid order is short by nothing, not by a negative amount. */
  readonly outstandingMinor: bigint;
  /** Zero unless confirmed exceeds the total. */
  readonly overpaidMinor: bigint;
  readonly state: SettlementState;
  /** Whether the order is settled enough to release goods. */
  readonly fullySettled: boolean;
}

export function summariseBalance(
  orderTotalMinor: bigint,
  payments: readonly ConfirmedPayment[],
  currency: string,
): BalanceSummary {
  if (orderTotalMinor < 0n) throw new Error('an order total cannot be negative');

  const total: Money = money(orderTotalMinor, currency);
  const confirmed = sum(
    payments.map((payment) => money(payment.amountConfirmedMinor, currency)),
    currency,
  );

  const difference = subtract(total, confirmed).amountMinor;

  const outstandingMinor = difference > 0n ? difference : 0n;
  const overpaidMinor = difference < 0n ? -difference : 0n;

  const state: SettlementState =
    confirmed.amountMinor === 0n
      ? 'UNPAID'
      : overpaidMinor > 0n
        ? 'OVERPAID'
        : outstandingMinor === 0n
          ? 'PAID'
          : 'PARTIALLY_PAID';

  return {
    currency,
    orderTotalMinor,
    confirmedMinor: confirmed.amountMinor,
    outstandingMinor,
    overpaidMinor,
    state,
    // An overpaid order is settled: the goods are paid for, and the surplus is a separate
    // conversation rather than a reason to hold the delivery.
    fullySettled: outstandingMinor === 0n,
  };
}

/** The order-level payment status implied by a balance. Maps onto the Prisma enum. */
export function paymentStatusFor(
  summary: BalanceSummary,
  paymentType: 'CASH' | 'CREDIT',
  creditDue: boolean,
): 'UNPAID' | 'PARTIALLY_PAID' | 'NOT_REQUIRED_YET' | 'PAID' {
  if (summary.fullySettled) return 'PAID';
  if (summary.confirmedMinor > 0n) return 'PARTIALLY_PAID';

  // A credit order owes nothing until its due date passes. After that it is simply unpaid, and
  // continuing to call it "not required yet" would hide a receivable from the people chasing it.
  if (paymentType === 'CREDIT' && !creditDue) return 'NOT_REQUIRED_YET';
  return 'UNPAID';
}
