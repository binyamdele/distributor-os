import { hashPayload } from '@/platform/security';
import type { MatchFactorCode } from './matching';

/**
 * The payment confirmation fingerprint.
 *
 * The same mechanism as the Phase 3 approval binding, reused rather than reinvented — it is the
 * same shape of problem: a specific person putting their name to specific figures. `hashPayload`
 * type-tags its values, which matters here because every amount is a bigint and a collision
 * between `48730000n` and `"48730000"` would sit directly on the money path.
 *
 * ## What is bound, and why
 *
 * - **organization, payment, order, customer** — a hash can never be valid across tenants or
 *   documents.
 * - **the order total and the outstanding balance at the moment of confirmation** — Finance is
 *   confirming that *this* amount settles *that* balance. If the balance moved because another
 *   payment was confirmed first, this confirmation was for a different situation.
 * - **claimed and confirmed amounts** — what was said, and what was accepted.
 * - **method, provider, reference, payment date** — the identity of the transfer.
 * - **the evidence content hash** — the exact bytes reviewed. Swapping the file afterwards
 *   cannot inherit the approval, and the filename is deliberately not part of identity.
 * - **the matching factor codes** — the warnings Finance was shown. Confirming despite a
 *   mismatch is a decision, and the record should say which mismatch was accepted.
 *
 * ## What is not
 *
 * Timestamps, the submitter, and the rejection reason. None of them changes what is being
 * accepted about the money.
 */

export interface PaymentConfirmationPayload {
  readonly organizationId: string;
  readonly paymentId: string;
  readonly salesOrderId: string;
  readonly customerId: string;
  readonly currency: string;
  readonly orderTotalMinor: bigint;
  readonly outstandingBeforeMinor: bigint;
  readonly amountClaimedMinor: bigint;
  readonly amountConfirmedMinor: bigint;
  readonly method: string;
  readonly providerName: string | null;
  readonly transactionReference: string | null;
  /** Calendar date, or null. Never a timestamp: the time of day is not a commercial fact. */
  readonly paymentDate: string | null;
  /** SHA-256 of the evidence bytes, or null when the payment was recorded without evidence. */
  readonly evidenceContentHash: string | null;
  /** Sorted, so the order factors happen to be generated in cannot change the hash. */
  readonly matchFactorCodes: readonly string[];
}

export function buildConfirmationPayload(input: {
  organizationId: string;
  paymentId: string;
  salesOrderId: string;
  customerId: string;
  currency: string;
  orderTotalMinor: bigint;
  outstandingBeforeMinor: bigint;
  amountClaimedMinor: bigint;
  amountConfirmedMinor: bigint;
  method: string;
  providerName: string | null;
  transactionReference: string | null;
  paymentDate: Date | null;
  evidenceContentHash: string | null;
  matchFactorCodes: readonly MatchFactorCode[];
}): PaymentConfirmationPayload {
  return {
    organizationId: input.organizationId,
    paymentId: input.paymentId,
    salesOrderId: input.salesOrderId,
    customerId: input.customerId,
    currency: input.currency,
    orderTotalMinor: input.orderTotalMinor,
    outstandingBeforeMinor: input.outstandingBeforeMinor,
    amountClaimedMinor: input.amountClaimedMinor,
    amountConfirmedMinor: input.amountConfirmedMinor,
    method: input.method,
    providerName: input.providerName,
    transactionReference: input.transactionReference,
    // A calendar date in UTC, so the machine's timezone cannot enter the hash.
    paymentDate: input.paymentDate ? input.paymentDate.toISOString().slice(0, 10) : null,
    evidenceContentHash: input.evidenceContentHash,
    matchFactorCodes: [...input.matchFactorCodes].sort(),
  };
}

export function confirmationPayloadHash(payload: PaymentConfirmationPayload): string {
  return hashPayload(payload);
}
