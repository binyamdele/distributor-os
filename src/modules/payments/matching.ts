/**
 * Payment matching.
 *
 * Produces a list of **explainable factors**, not a score. There is no confidence number here on
 * purpose: a figure like "0.87 match" invites a Finance user to trust the number instead of
 * reading the evidence, and it is not derived from anything that justifies that trust. What a
 * person needs is the two amounts side by side and the difference between them.
 *
 * Every factor is a deterministic comparison of the payment against the order. Nothing here
 * consults a model, and nothing here decides anything — the factors are shown, and Finance
 * decides.
 */

export type MatchFactorCode =
  | 'EXACT_AMOUNT_MATCH'
  | 'SETTLES_OUTSTANDING'
  | 'AMOUNT_BELOW_OUTSTANDING'
  | 'AMOUNT_ABOVE_OUTSTANDING'
  | 'CURRENCY_MISMATCH'
  | 'MISSING_REFERENCE'
  | 'DUPLICATE_REFERENCE'
  | 'PAYER_NAME_DIFFERS'
  | 'CLAIM_DIFFERS_FROM_EVIDENCE'
  | 'PAYMENT_DATE_MISSING'
  | 'ORDER_NOT_OPEN';

export type FactorSeverity = 'INFO' | 'WARNING' | 'BLOCKING';

export interface MatchFactor {
  readonly code: MatchFactorCode;
  readonly severity: FactorSeverity;
  /** Shown to Finance verbatim. States figures rather than characterising them. */
  readonly detail: string;
}

export interface MatchInput {
  readonly currency: string;
  readonly orderCurrency: string;
  readonly orderOutstandingMinor: bigint;
  /** What the submitter claims was paid. */
  readonly amountClaimedMinor: bigint;
  /** What the extractor read, if anything. */
  readonly amountExtractedMinor: bigint | null;
  readonly transactionReference: string | null;
  /** True when a confirmed payment already carries this provider and reference. */
  readonly duplicateReference: boolean;
  readonly payerName: string | null;
  readonly customerName: string;
  readonly paymentDate: Date | null;
  readonly orderStatus: string;
}

function formatMinor(amountMinor: bigint, currency: string): string {
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currency} ${whole}.${digits.slice(-2)}`;
}

/**
 * Loosely compares two names.
 *
 * A payer name almost never matches a company name exactly — a director pays personally, a
 * clerk's name is on the slip, the bank abbreviates. So this raises an *informational* factor
 * when they differ rather than treating it as a problem, because treating every mismatch as
 * suspicious would train Finance to ignore the flag entirely.
 */
function namesLookRelated(payer: string, customer: string): boolean {
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .replace(/\b(plc|llc|ltd|limited|trading|construction|contractors|company|co)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const a = normalise(payer);
  const b = normalise(customer);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a) || a.split(' ').some((word) => word.length > 3 && b.includes(word));
}

export function assessMatch(input: MatchInput): MatchFactor[] {
  const factors: MatchFactor[] = [];

  if (input.orderStatus !== 'OPEN') {
    factors.push({
      code: 'ORDER_NOT_OPEN',
      severity: 'BLOCKING',
      detail: `This order is ${input.orderStatus.toLowerCase()}, so a payment cannot be confirmed against it.`,
    });
  }

  if (input.currency !== input.orderCurrency) {
    factors.push({
      code: 'CURRENCY_MISMATCH',
      severity: 'BLOCKING',
      detail: `The payment is in ${input.currency} and the order is in ${input.orderCurrency}.`,
    });
  }

  // The amount that will actually be applied is the claim; the extraction is corroboration.
  const claimed = input.amountClaimedMinor;
  const outstanding = input.orderOutstandingMinor;

  if (claimed === outstanding) {
    factors.push({
      code: 'EXACT_AMOUNT_MATCH',
      severity: 'INFO',
      detail: `The amount matches the outstanding balance exactly: ${formatMinor(outstanding, input.orderCurrency)}.`,
    });
  } else if (claimed < outstanding) {
    factors.push({
      code: 'AMOUNT_BELOW_OUTSTANDING',
      severity: 'WARNING',
      detail:
        `Outstanding ${formatMinor(outstanding, input.orderCurrency)}, ` +
        `payment ${formatMinor(claimed, input.currency)} — ` +
        `${formatMinor(outstanding - claimed, input.orderCurrency)} would remain.`,
    });
  } else {
    factors.push({
      code: 'AMOUNT_ABOVE_OUTSTANDING',
      severity: 'WARNING',
      detail:
        `Outstanding ${formatMinor(outstanding, input.orderCurrency)}, ` +
        `payment ${formatMinor(claimed, input.currency)} — ` +
        `${formatMinor(claimed - outstanding, input.orderCurrency)} more than owed.`,
    });
  }

  if (claimed === outstanding && outstanding > 0n) {
    factors.push({
      code: 'SETTLES_OUTSTANDING',
      severity: 'INFO',
      detail: 'Confirming this would settle the order in full.',
    });
  }

  // The claim and the evidence disagreeing is the single most useful thing to surface, and it
  // is shown as two figures and a difference rather than as a judgement.
  if (input.amountExtractedMinor !== null && input.amountExtractedMinor !== claimed) {
    const difference = claimed - input.amountExtractedMinor;
    factors.push({
      code: 'CLAIM_DIFFERS_FROM_EVIDENCE',
      severity: 'WARNING',
      detail:
        `Entered ${formatMinor(claimed, input.currency)}, ` +
        `evidence reads ${formatMinor(input.amountExtractedMinor, input.currency)} — ` +
        `difference ${formatMinor(difference < 0n ? -difference : difference, input.currency)}.`,
    });
  }

  if (!input.transactionReference) {
    factors.push({
      code: 'MISSING_REFERENCE',
      severity: 'WARNING',
      detail: 'No transaction reference, so this payment cannot be traced back to a transfer.',
    });
  } else if (input.duplicateReference) {
    // Deliberately says nothing about the other payment: which order it belongs to and who its
    // customer is would turn this message into an oracle.
    factors.push({
      code: 'DUPLICATE_REFERENCE',
      severity: 'BLOCKING',
      detail: `Reference "${input.transactionReference}" is already on a confirmed payment.`,
    });
  }

  if (input.payerName && !namesLookRelated(input.payerName, input.customerName)) {
    factors.push({
      code: 'PAYER_NAME_DIFFERS',
      severity: 'INFO',
      detail: `Paid by "${input.payerName}", customer is "${input.customerName}".`,
    });
  }

  if (!input.paymentDate) {
    factors.push({
      code: 'PAYMENT_DATE_MISSING',
      severity: 'INFO',
      detail: 'No payment date recorded.',
    });
  }

  return factors;
}

/** Factors that must be resolved before Finance may confirm at all. */
export function blockingFactors(factors: readonly MatchFactor[]): MatchFactor[] {
  return factors.filter((factor) => factor.severity === 'BLOCKING');
}

export function hasWarnings(factors: readonly MatchFactor[]): boolean {
  return factors.some((factor) => factor.severity === 'WARNING');
}
