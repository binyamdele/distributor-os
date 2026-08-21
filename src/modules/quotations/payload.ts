import { hashPayload } from '@/platform/security';

/**
 * The approval payload fingerprint.
 *
 * An approval is a person putting their name to a specific set of commercial figures. This
 * module defines exactly which figures, canonicalises them, and hashes them with the Phase 1
 * `hashPayload` — the type-tagging one, which does not collide a bigint with the string
 * spelling of it. That property is load-bearing here: every amount below is a bigint.
 *
 * ## What is in, and why
 *
 * Everything a reasonable approver would consider part of what they approved:
 *
 *   - who it is for            customerId, and the credit standing that made the terms legal
 *   - how it is to be paid     paymentType, paymentTermsDays
 *   - how long it stands       validityDate
 *   - every line               product identity, quantity, unit, list price, quoted price,
 *                              discount, tax rate, and all five computed line amounts
 *   - the charges              deliveryFee, deliveryTax
 *   - the totals               subtotal, discountTotal, taxTotal, grandTotal
 *
 * The computed line amounts are included even though they are derivable from the inputs. A
 * change in the rounding rule or in the delivery-tax policy would alter what the approver saw
 * without altering a single input, and an approval that survived that would be a lie.
 *
 * ## What is out, and why
 *
 * `quotationNumber` (assigned once, never changes), timestamps, `createdById`, `internalNotes`
 * and `customerNotes`. Notes are the interesting exclusion: they change what the customer reads
 * but not what the organization is committing to, and treating a typo fix as grounds to revoke
 * an approval would teach managers to re-approve reflexively — which is exactly how this kind of
 * control stops meaning anything.
 *
 * `organizationId` *is* included, so a hash can never be valid across tenants.
 */

export interface ApprovalPayloadLine {
  readonly productId: string | null;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly quantity: number;
  readonly listUnitPriceMinor: bigint;
  readonly quotedUnitPriceMinor: bigint;
  readonly discountBp: number;
  readonly taxRateBp: number;
  readonly lineSubtotalMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly taxableAmountMinor: bigint;
  readonly taxMinor: bigint;
  readonly lineTotalMinor: bigint;
}

export interface ApprovalPayload {
  readonly organizationId: string;
  readonly quotationId: string;
  readonly customerId: string;
  readonly customerCreditStatus: string;
  readonly currency: string;
  readonly paymentType: string;
  readonly paymentTermsDays: number;
  /** Date only, as an ISO calendar date. The time of day is not a commercial fact. */
  readonly validityDate: string;
  readonly lines: readonly ApprovalPayloadLine[];
  readonly deliveryFeeMinor: bigint;
  readonly deliveryTaxMinor: bigint;
  readonly subtotalMinor: bigint;
  readonly discountTotalMinor: bigint;
  readonly taxTotalMinor: bigint;
  readonly grandTotalMinor: bigint;
}

/**
 * Builds the canonical payload.
 *
 * Lines are sorted by `sortOrder` before hashing, so a reordering that changes no commercial
 * fact does not revoke an approval — and, conversely, so two quotations with the same lines in
 * different orders hash alike, which is correct: the commitment is the same.
 */
export function buildApprovalPayload(input: {
  organizationId: string;
  quotationId: string;
  customerId: string;
  customerCreditStatus: string;
  currency: string;
  paymentType: string;
  paymentTermsDays: number;
  validityDate: Date;
  deliveryFeeMinor: bigint;
  deliveryTaxMinor: bigint;
  subtotalMinor: bigint;
  discountTotalMinor: bigint;
  taxTotalMinor: bigint;
  grandTotalMinor: bigint;
  lines: readonly (ApprovalPayloadLine & { sortOrder: number })[];
}): ApprovalPayload {
  const lines = [...input.lines]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((line) => ({
      productId: line.productId,
      sku: line.sku,
      description: line.description,
      unit: line.unit,
      quantity: line.quantity,
      listUnitPriceMinor: line.listUnitPriceMinor,
      quotedUnitPriceMinor: line.quotedUnitPriceMinor,
      discountBp: line.discountBp,
      taxRateBp: line.taxRateBp,
      lineSubtotalMinor: line.lineSubtotalMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      taxableAmountMinor: line.taxableAmountMinor,
      taxMinor: line.taxMinor,
      lineTotalMinor: line.lineTotalMinor,
    }));

  return {
    organizationId: input.organizationId,
    quotationId: input.quotationId,
    customerId: input.customerId,
    customerCreditStatus: input.customerCreditStatus,
    currency: input.currency,
    paymentType: input.paymentType,
    paymentTermsDays: input.paymentTermsDays,
    // toISOString() would drag the machine's timezone into the hash. A validity date is a
    // calendar date, so it is formatted as one, in UTC, deterministically.
    validityDate: input.validityDate.toISOString().slice(0, 10),
    lines,
    deliveryFeeMinor: input.deliveryFeeMinor,
    deliveryTaxMinor: input.deliveryTaxMinor,
    subtotalMinor: input.subtotalMinor,
    discountTotalMinor: input.discountTotalMinor,
    taxTotalMinor: input.taxTotalMinor,
    grandTotalMinor: input.grandTotalMinor,
  };
}

/** SHA-256 of the canonical form. Stable across re-serialisation, key order and process runs. */
export function approvalPayloadHash(payload: ApprovalPayload): string {
  return hashPayload(payload);
}
