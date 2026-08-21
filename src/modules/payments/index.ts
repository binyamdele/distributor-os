import 'server-only';
import { z } from 'zod';
import { type TenantTransaction, withTenant } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { isUuid } from '@/platform/ids';
import { type Result, fail, ok } from '@/platform/result';
import { parseDecimal } from '@/platform/money';
import { fileStore, validateEvidenceUpload } from '@/platform/storage';
import { parseCalendarDate, paymentExtractor, validateExtractedPayment } from '@/platform/payments';
import type { PaymentExtractor } from '@/platform/payments';
import { recordAudit } from '@/modules/audit';
import { type BalanceSummary, paymentStatusFor, summariseBalance } from './balance';
import { type MatchFactor, assessMatch, blockingFactors } from './matching';
import { buildConfirmationPayload, confirmationPayloadHash } from './payload';

export * from './balance';
export * from './matching';
export * from './payload';
export * from './receivables';
export * from './queries';

export const PAYMENT_METHODS = [
  'BANK_TRANSFER',
  'TELEBIRR',
  'MOBILE_MONEY',
  'CASH_DEPOSIT',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['SUBMITTED', 'NEEDS_REVIEW', 'CONFIRMED', 'REJECTED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Permitted transitions.
 *
 * `CONFIRMED` and `REJECTED` are terminal. A confirmed payment is immutable — enforced by a
 * database trigger as well as here — because correcting money in place rewrites what Finance
 * put their name to. Correction is a reversal in a later phase: a second recorded fact, not an
 * edit of the first.
 */
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  SUBMITTED: ['NEEDS_REVIEW', 'CONFIRMED', 'REJECTED'],
  NEEDS_REVIEW: ['CONFIRMED', 'REJECTED'],
  CONFIRMED: [],
  REJECTED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isReviewable(status: PaymentStatus): boolean {
  return status === 'SUBMITTED' || status === 'NEEDS_REVIEW';
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/** Whether a credit order's due date has passed. Query-derived; nothing schedules this. */
export function creditIsDue(paymentDueDate: Date | null, now: Date = new Date()): boolean {
  if (!paymentDueDate) return false;
  const due = new Date(
    Date.UTC(
      paymentDueDate.getUTCFullYear(),
      paymentDueDate.getUTCMonth(),
      paymentDueDate.getUTCDate(),
    ),
  );
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return today > due;
}

/**
 * Recomputes an order's balance from its confirmed payments.
 *
 * Always derived, never read from a stored figure. Called inside the confirmation transaction
 * so the total reflects anything another transaction committed first.
 */
export async function orderBalance(
  tx: TenantTransaction,
  salesOrderId: string,
): Promise<Result<BalanceSummary & { orderId: string }>> {
  if (!isUuid(salesOrderId)) return fail('NOT_FOUND', 'error.notFound');

  const order = await tx.salesOrder.findFirst({ where: { id: salesOrderId } });
  if (!order) return fail('NOT_FOUND', 'error.notFound');

  const confirmed = await tx.payment.findMany({
    where: { salesOrderId, status: 'CONFIRMED' },
    select: { amountConfirmedMinor: true },
  });

  const summary = summariseBalance(
    order.grandTotalMinor,
    confirmed.map((payment) => ({ amountConfirmedMinor: payment.amountConfirmedMinor ?? 0n })),
    order.currency,
  );

  return ok({ ...summary, orderId: order.id });
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export const submitPaymentSchema = z.object({
  salesOrderId: z.string().uuid(),
  /** A decimal string typed by a human. Never a float on the way in. */
  amountClaimed: z.string().trim().min(1),
  method: z.enum(PAYMENT_METHODS),
  providerName: z.string().trim().max(120).optional().or(z.literal('')),
  transactionReference: z.string().trim().max(120).optional().or(z.literal('')),
  payerName: z.string().trim().max(200).optional().or(z.literal('')),
  paymentDate: z.string().trim().optional().or(z.literal('')),
});

export interface EvidenceUpload {
  readonly bytes: Uint8Array;
  readonly claimedMimeType: string | null;
  readonly filename: string | null;
}

/**
 * Records a claimed payment, optionally with evidence.
 *
 * This creates a *claim*. It moves no money, changes no order state, and anyone with
 * `submit:payment-evidence` can do it — which is exactly why it is separated from confirmation.
 */
export async function submitPayment(
  tx: TenantTransaction,
  context: ActorContext,
  raw: unknown,
  evidence?: EvidenceUpload,
): Promise<Result<{ id: string; evidenceFileId: string | null }>> {
  const parsed = submitPaymentSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'error.generic');
  }
  const input = parsed.data;

  const order = await tx.salesOrder.findFirst({
    where: { id: input.salesOrderId },
    include: { customer: { select: { id: true } } },
  });
  if (!order) return fail('NOT_FOUND', 'error.notFound');

  if (order.status !== 'OPEN') {
    return fail(
      'INVALID_STATE_TRANSITION',
      `Order ${order.orderNumber} is ${order.status.toLowerCase()}, so a payment cannot be recorded against it.`,
    );
  }

  const amount = parseDecimal(input.amountClaimed, order.currency);
  if (!amount.ok) return amount;
  if (amount.value.amountMinor <= 0n) {
    return fail('VALIDATION_FAILED', 'A payment amount must be greater than zero.');
  }

  // --- evidence, validated from its bytes ---------------------------------
  let evidenceFileId: string | null = null;
  if (evidence) {
    const verdict = validateEvidenceUpload({
      bytes: evidence.bytes,
      claimedMimeType: evidence.claimedMimeType,
      filename: evidence.filename,
    });
    if (!verdict.ok) {
      return fail('VALIDATION_FAILED', verdict.message, { problem: verdict.problem });
    }

    const stored = await fileStore().put({
      bytes: evidence.bytes,
      mimeType: verdict.detectedMimeType!,
      organizationId: context.organizationId,
    });

    const file = await tx.paymentEvidenceFile.create({
      data: {
        organizationId: context.organizationId,
        storageKey: stored.key,
        contentHash: stored.contentHash,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        // Display only. Never used to locate the file.
        originalFilename: evidence.filename?.slice(0, 200) ?? null,
        uploadedById: context.userId,
      },
    });
    evidenceFileId = file.id;
  }

  // Strict: 2026-02-30 is refused rather than rolled forward to 2 March.
  const paymentDate = input.paymentDate ? parseCalendarDate(input.paymentDate) : null;
  if (input.paymentDate && !paymentDate) {
    return fail('VALIDATION_FAILED', 'That payment date is not a real date.');
  }

  const payment = await tx.payment.create({
    data: {
      organizationId: context.organizationId,
      salesOrderId: order.id,
      customerId: order.customerId,
      status: 'SUBMITTED',
      currency: order.currency,
      amountClaimedMinor: amount.value.amountMinor,
      method: input.method,
      providerName: input.providerName?.trim() || null,
      transactionReference: input.transactionReference?.trim() || null,
      payerName: input.payerName?.trim() || null,
      paymentDate,
      evidenceFileId,
      extractionStatus: 'NOT_ATTEMPTED',
      submittedById: context.userId!,
    },
  });

  await recordAudit(tx, context, {
    action: 'payment.evidence_submitted',
    entityType: 'payment',
    entityId: payment.id,
    newState: {
      salesOrderId: order.id,
      orderNumber: order.orderNumber,
      amountClaimedMinor: amount.value.amountMinor.toString(),
      method: input.method,
      hasEvidence: evidenceFileId !== null,
      // The hash rather than the file: an audit log should not carry a bank slip.
      evidenceContentHash: evidenceFileId
        ? (await tx.paymentEvidenceFile.findFirst({ where: { id: evidenceFileId } }))?.contentHash
        : null,
    },
  });

  return ok({ id: payment.id, evidenceFileId });
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Runs the extractor over a payment's evidence and stores the proposal.
 *
 * Like the Phase 2 parse, the provider call happens outside a transaction — it can take seconds
 * and must not hold a connection. And like the Phase 2 parse, a failure is a recoverable state,
 * not a dead end: the payment lands in `NEEDS_REVIEW` either way, and Finance types the figures
 * by hand if the extractor could not read them.
 *
 * Nothing extracted is applied to anything. It fills in fields on a claim.
 */
export async function runExtraction(
  organizationId: string,
  context: ActorContext,
  paymentId: string,
  extractor: PaymentExtractor = paymentExtractor(),
): Promise<Result<{ status: PaymentStatus; extracted: boolean }>> {
  if (!isUuid(paymentId)) return fail('NOT_FOUND', 'error.notFound');

  const loaded = await withTenant(organizationId, async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId },
      include: { evidenceFile: true, salesOrder: { select: { currency: true } } },
    });
    if (!payment) return fail<{ storageKey: string; mimeType: string; currency: string }>('NOT_FOUND', 'error.notFound');
    if (!isReviewable(payment.status as PaymentStatus)) {
      return fail<{ storageKey: string; mimeType: string; currency: string }>(
        'INVALID_STATE_TRANSITION',
        'This payment has already been decided.',
      );
    }
    if (!payment.evidenceFile) {
      return fail<{ storageKey: string; mimeType: string; currency: string }>(
        'VALIDATION_FAILED',
        'There is no evidence attached to extract from.',
      );
    }
    return ok({
      storageKey: payment.evidenceFile.storageKey,
      mimeType: payment.evidenceFile.mimeType,
      currency: payment.currency,
    });
  });

  if (!loaded.ok) return loaded;

  const bytes = await fileStore().read(loaded.value.storageKey);
  if (!bytes) {
    return withTenant(organizationId, async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'NEEDS_REVIEW', extractionStatus: 'FAILED', extractionError: 'EVIDENCE_UNREADABLE' },
      });
      return fail('INTERNAL', 'The evidence file could not be read. Enter the details by hand.');
    });
  }

  const outcome = await extractor.extract({
    bytes,
    mimeType: loaded.value.mimeType,
    expectedCurrency: loaded.value.currency,
  });

  return withTenant(organizationId, async (tx) => {
    if (!outcome.ok) {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'NEEDS_REVIEW',
          extractionStatus: outcome.errorCode === 'SCHEMA_INVALID' ? 'SCHEMA_INVALID' : 'FAILED',
          extractionError: outcome.errorCode,
        },
      });

      await recordAudit(tx, context, {
        action: 'payment.extraction_failed',
        entityType: 'payment',
        entityId: paymentId,
        newState: { errorCode: outcome.errorCode, provider: outcome.meta.provider },
        aiInvolved: true,
      });

      // Not an error the caller must handle: the workflow continues by hand.
      return ok({ status: 'NEEDS_REVIEW' as PaymentStatus, extracted: false });
    }

    const value = outcome.value;
    const sane = validateExtractedPayment(value);
    if (!sane.ok) {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'NEEDS_REVIEW', extractionStatus: 'SCHEMA_INVALID', extractionError: sane.message },
      });
      return ok({ status: 'NEEDS_REVIEW' as PaymentStatus, extracted: false });
    }

    // The extraction fills only fields the submitter left blank. It never overwrites a figure a
    // person entered — a human's typing outranks a machine's reading.
    const existing = await tx.payment.findFirstOrThrow({ where: { id: paymentId } });
    const extractedAmount = value.amount ? parseDecimal(value.amount, existing.currency) : null;

    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: 'NEEDS_REVIEW',
        extractionStatus: 'SUCCEEDED',
        extractionError: null,
        providerName: existing.providerName ?? value.providerName,
        transactionReference: existing.transactionReference ?? value.transactionReference,
        payerName: existing.payerName ?? value.payerName,
        paymentDate:
          existing.paymentDate ??
          (value.paymentDate ? parseCalendarDate(value.paymentDate) : null),
      },
    });

    await recordAudit(tx, context, {
      action: 'payment.extraction_succeeded',
      entityType: 'payment',
      entityId: paymentId,
      newState: {
        provider: outcome.meta.provider,
        // The figure that was read, so a later dispute can see what the machine proposed.
        extractedAmountMinor:
          extractedAmount?.ok === true ? extractedAmount.value.amountMinor.toString() : null,
        hasReference: value.transactionReference !== null,
      },
      aiInvolved: true,
    });

    return ok({ status: 'NEEDS_REVIEW' as PaymentStatus, extracted: true });
  });
}

// ---------------------------------------------------------------------------
// Correction
// ---------------------------------------------------------------------------

export const correctionSchema = z.object({
  amountClaimed: z.string().trim().min(1),
  method: z.enum(PAYMENT_METHODS),
  providerName: z.string().trim().max(120).optional().or(z.literal('')),
  transactionReference: z.string().trim().max(120).optional().or(z.literal('')),
  payerName: z.string().trim().max(200).optional().or(z.literal('')),
  paymentDate: z.string().trim().optional().or(z.literal('')),
});

/** Lets Finance fix what the extractor read, or fill in what it could not. */
export async function correctPaymentMetadata(
  tx: TenantTransaction,
  context: ActorContext,
  paymentId: string,
  raw: unknown,
): Promise<Result<null>> {
  const parsed = correctionSchema.safeParse(raw);
  if (!parsed.success) return fail('VALIDATION_FAILED', 'Check the payment details.');
  if (!isUuid(paymentId)) return fail('NOT_FOUND', 'error.notFound');

  const payment = await tx.payment.findFirst({ where: { id: paymentId } });
  if (!payment) return fail('NOT_FOUND', 'error.notFound');
  if (!isReviewable(payment.status as PaymentStatus)) {
    // The trigger would refuse this too. Failing here gives a better message.
    return fail(
      'INVALID_STATE_TRANSITION',
      'A confirmed or rejected payment cannot be edited. Record a reversal instead.',
    );
  }

  const amount = parseDecimal(parsed.data.amountClaimed, payment.currency);
  if (!amount.ok) return amount;
  if (amount.value.amountMinor <= 0n) {
    return fail('VALIDATION_FAILED', 'A payment amount must be greater than zero.');
  }

  const paymentDate = parsed.data.paymentDate ? parseCalendarDate(parsed.data.paymentDate) : null;
  if (parsed.data.paymentDate && !paymentDate) {
    return fail('VALIDATION_FAILED', 'That payment date is not a real date.');
  }

  await tx.payment.update({
    where: { id: paymentId },
    data: {
      status: 'NEEDS_REVIEW',
      amountClaimedMinor: amount.value.amountMinor,
      method: parsed.data.method,
      providerName: parsed.data.providerName?.trim() || null,
      transactionReference: parsed.data.transactionReference?.trim() || null,
      payerName: parsed.data.payerName?.trim() || null,
      paymentDate,
    },
  });

  await recordAudit(tx, context, {
    action: 'payment.metadata_corrected',
    entityType: 'payment',
    entityId: paymentId,
    oldState: {
      amountClaimedMinor: payment.amountClaimedMinor.toString(),
      transactionReference: payment.transactionReference,
    },
    newState: {
      amountClaimedMinor: amount.value.amountMinor.toString(),
      transactionReference: parsed.data.transactionReference?.trim() || null,
    },
  });

  return ok(null);
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export interface PaymentAssessment {
  readonly factors: readonly MatchFactor[];
  readonly blocking: readonly MatchFactor[];
  readonly balance: BalanceSummary;
  readonly payloadHash: string;
}

/**
 * Builds the factors and the confirmation payload for a payment.
 *
 * Used both to render the review screen and, again inside the confirmation transaction, to
 * decide. Deriving it twice rather than carrying it from the screen is what makes the binding
 * survive a race: a confirmation that runs after another payment committed sees the new balance.
 */
async function assess(
  tx: TenantTransaction,
  organizationId: string,
  paymentId: string,
): Promise<Result<PaymentAssessment & { payment: { id: string; status: PaymentStatus } }>> {
  if (!isUuid(paymentId)) return fail('NOT_FOUND', 'error.notFound');

  const payment = await tx.payment.findFirst({
    where: { id: paymentId },
    include: {
      evidenceFile: { select: { contentHash: true } },
      salesOrder: true,
      customer: { select: { companyName: true } },
    },
  });
  if (!payment) return fail('NOT_FOUND', 'error.notFound');

  const balanceResult = await orderBalance(tx, payment.salesOrderId);
  if (!balanceResult.ok) return balanceResult;
  const balance = balanceResult.value;

  // Scoped to CONFIRMED payments in this organization, on provider + reference. Excludes this
  // payment so re-assessing a confirmed one does not flag itself.
  const duplicateReference = payment.transactionReference
    ? (await tx.payment.count({
        where: {
          id: { not: paymentId },
          status: 'CONFIRMED',
          transactionReference: payment.transactionReference,
          providerName: payment.providerName,
        },
      })) > 0
    : false;

  const factors = assessMatch({
    currency: payment.currency,
    orderCurrency: payment.salesOrder.currency,
    orderOutstandingMinor: balance.outstandingMinor,
    amountClaimedMinor: payment.amountClaimedMinor,
    // Extraction fills blank fields rather than a separate column, so the comparison the UI
    // needs is between what Finance sees and what the order says.
    amountExtractedMinor: null,
    transactionReference: payment.transactionReference,
    duplicateReference,
    payerName: payment.payerName,
    customerName: payment.customer.companyName,
    paymentDate: payment.paymentDate,
    orderStatus: payment.salesOrder.status,
  });

  const payload = buildConfirmationPayload({
    organizationId,
    paymentId: payment.id,
    salesOrderId: payment.salesOrderId,
    customerId: payment.customerId,
    currency: payment.currency,
    orderTotalMinor: payment.salesOrder.grandTotalMinor,
    outstandingBeforeMinor: balance.outstandingMinor,
    amountClaimedMinor: payment.amountClaimedMinor,
    amountConfirmedMinor: payment.amountClaimedMinor,
    method: payment.method,
    providerName: payment.providerName,
    transactionReference: payment.transactionReference,
    paymentDate: payment.paymentDate,
    evidenceContentHash: payment.evidenceFile?.contentHash ?? null,
    matchFactorCodes: factors.map((factor) => factor.code),
  });

  return ok({
    factors,
    blocking: blockingFactors(factors),
    balance,
    payloadHash: confirmationPayloadHash(payload),
    payment: { id: payment.id, status: payment.status as PaymentStatus },
  });
}

export async function assessPayment(
  tx: TenantTransaction,
  organizationId: string,
  paymentId: string,
): Promise<Result<PaymentAssessment>> {
  const result = await assess(tx, organizationId, paymentId);
  if (!result.ok) return result;
  const { payment: _payment, ...assessment } = result.value;
  return ok(assessment);
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  /** The payload hash Finance was shown. Refused if the figures moved since. */
  readonly expectedPayloadHash?: string;
}

export interface ConfirmResult {
  /**
   * The order this payment settled against.
   *
   * Returned because confirming changes what the order screen says about itself, and the caller
   * is the only thing that knows how to invalidate that screen. Without it the web layer has to
   * guess, and an order that quietly keeps showing "Unpaid" after the money was confirmed is
   * exactly the sort of thing someone acts on.
   */
  readonly salesOrderId: string;
  readonly orderNumber: string;
  readonly payloadHash: string;
  readonly alreadyConfirmed: boolean;
  readonly balance: BalanceSummary;
  readonly orderNowPaid: boolean;
  readonly orderNowReady: boolean;
}

/**
 * Confirms a payment. The only path to authoritative payment truth.
 *
 * The sequence, all in one transaction:
 *
 *   1. lock the payment row, then the order row — always that order
 *   2. re-derive the balance and the factors from what is stored
 *   3. refuse on any blocking factor, on a decided payment, on a non-open order
 *   4. mark the payment confirmed, binding the payload hash
 *   5. recompute the balance *including* this payment
 *   6. move the order's payment status, and its fulfilment status if it is now settled
 *   7. audit
 *
 * Step 2 is what makes this safe under concurrency. Two payments confirmed at the same moment
 * are serialised by the payment locks, and the second one recomputes a balance that already
 * includes the first.
 */
export async function confirmPayment(
  tx: TenantTransaction,
  context: ActorContext,
  paymentId: string,
  options: ConfirmOptions = {},
): Promise<Result<ConfirmResult>> {
  // Checked before the `::uuid` casts below, which would otherwise raise on a hand-typed id
  // and turn a request for something that does not exist into a 500.
  if (!isUuid(paymentId)) return fail('NOT_FOUND', 'error.notFound');

  // Payment first, then order. A fixed order across every payment operation, so two
  // confirmations against the same order cannot take the two locks in opposite sequences.
  const locked = await tx.$queryRaw<{ id: string; sales_order_id: string }[]>`
    SELECT id, sales_order_id FROM payments
     WHERE id = ${paymentId}::uuid
       AND organization_id = ${context.organizationId}::uuid
     FOR UPDATE
  `;
  if (locked.length === 0) return fail('NOT_FOUND', 'error.notFound');

  await tx.$executeRaw`
    SELECT id FROM sales_orders
     WHERE id = ${locked[0]!.sales_order_id}::uuid
       AND organization_id = ${context.organizationId}::uuid
     FOR UPDATE
  `;

  const assessed = await assess(tx, context.organizationId, paymentId);
  if (!assessed.ok) return assessed;

  const payment = await tx.payment.findFirstOrThrow({
    where: { id: paymentId },
    include: { salesOrder: true },
  });

  // Idempotent: a double-clicked Confirm is one decision, not two.
  if (payment.status === 'CONFIRMED') {
    const balance = await orderBalance(tx, payment.salesOrderId);
    if (!balance.ok) return balance;
    return ok({
      salesOrderId: payment.salesOrderId,
      orderNumber: payment.salesOrder.orderNumber,
      payloadHash: payment.confirmationPayloadHash!,
      alreadyConfirmed: true,
      balance: balance.value,
      orderNowPaid: payment.salesOrder.paymentStatus === 'PAID',
      orderNowReady: payment.salesOrder.fulfillmentStatus === 'READY',
    });
  }

  if (!isReviewable(payment.status as PaymentStatus)) {
    return fail('INVALID_STATE_TRANSITION', 'This payment has already been decided.');
  }

  if (options.expectedPayloadHash && options.expectedPayloadHash !== assessed.value.payloadHash) {
    return fail(
      'APPROVAL_PAYLOAD_MISMATCH',
      'The figures changed while you were reviewing. Reload and check them again before confirming.',
    );
  }

  if (assessed.value.blocking.length > 0) {
    return fail(
      'CONFLICT',
      assessed.value.blocking[0]!.detail,
      { factors: assessed.value.blocking.map((factor) => factor.code) },
      true,
    );
  }

  const confirmedAmount = payment.amountClaimedMinor;

  await tx.payment.update({
    where: { id: paymentId },
    data: {
      status: 'CONFIRMED',
      amountConfirmedMinor: confirmedAmount,
      reviewedById: context.userId,
      reviewedAt: new Date(),
      confirmationPayloadHash: assessed.value.payloadHash,
      matchFactors: assessed.value.factors.map((factor) => ({
        code: factor.code,
        severity: factor.severity,
        detail: factor.detail,
      })),
    },
  });

  // Recomputed *after* this payment counts, from the rows rather than by adding to a figure
  // read earlier.
  const after = await orderBalance(tx, payment.salesOrderId);
  if (!after.ok) return after;

  const order = payment.salesOrder;
  const nextPaymentStatus = paymentStatusFor(
    after.value,
    order.paymentType as 'CASH' | 'CREDIT',
    creditIsDue(order.paymentDueDate),
  );

  // Settling a cash order is what unlocks the warehouse. A credit order was already READY, and
  // paying it does not change that.
  const nextFulfillment =
    after.value.fullySettled && order.fulfillmentStatus === 'NOT_READY'
      ? 'READY'
      : order.fulfillmentStatus;

  await tx.salesOrder.update({
    where: { id: order.id },
    data: { paymentStatus: nextPaymentStatus, fulfillmentStatus: nextFulfillment },
  });

  await recordAudit(tx, context, {
    action: 'payment.confirmed',
    entityType: 'payment',
    entityId: paymentId,
    newState: {
      salesOrderId: order.id,
      orderNumber: order.orderNumber,
      amountConfirmedMinor: confirmedAmount.toString(),
      transactionReference: payment.transactionReference,
      // The evidence identity, not its contents.
      payloadHash: assessed.value.payloadHash,
      outstandingAfterMinor: after.value.outstandingMinor.toString(),
      overpaidMinor: after.value.overpaidMinor.toString(),
    },
    approvalStatus: 'CONFIRMED',
  });

  if (nextPaymentStatus !== order.paymentStatus) {
    await recordAudit(tx, context, {
      action: 'order.payment_status_changed',
      entityType: 'sales_order',
      entityId: order.id,
      oldState: { paymentStatus: order.paymentStatus },
      newState: { paymentStatus: nextPaymentStatus },
    });
  }

  if (nextFulfillment !== order.fulfillmentStatus) {
    await recordAudit(tx, context, {
      action: 'order.fulfillment_readiness_changed',
      entityType: 'sales_order',
      entityId: order.id,
      oldState: { fulfillmentStatus: order.fulfillmentStatus },
      newState: { fulfillmentStatus: nextFulfillment, because: 'payment confirmed in full' },
    });
  }

  if (after.value.overpaidMinor > 0n) {
    await recordAudit(tx, context, {
      action: 'payment.overpayment_detected',
      entityType: 'sales_order',
      entityId: order.id,
      newState: {
        overpaidMinor: after.value.overpaidMinor.toString(),
        // Recorded, never absorbed. No refund or credit balance exists yet.
        disposition: 'unallocated',
      },
    });
  }

  return ok({
    salesOrderId: order.id,
    orderNumber: order.orderNumber,
    payloadHash: assessed.value.payloadHash,
    alreadyConfirmed: false,
    balance: after.value,
    orderNowPaid: nextPaymentStatus === 'PAID',
    orderNowReady: nextFulfillment === 'READY',
  });
}

export async function rejectPayment(
  tx: TenantTransaction,
  context: ActorContext,
  paymentId: string,
  reason: string,
): Promise<Result<{ alreadyRejected: boolean; salesOrderId: string }>> {
  if (!isUuid(paymentId)) return fail('NOT_FOUND', 'error.notFound');

  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payments
     WHERE id = ${paymentId}::uuid
       AND organization_id = ${context.organizationId}::uuid
     FOR UPDATE
  `;
  if (locked.length === 0) return fail('NOT_FOUND', 'error.notFound');

  const payment = await tx.payment.findFirstOrThrow({ where: { id: paymentId } });

  if (payment.status === 'REJECTED') {
    return ok({ alreadyRejected: true, salesOrderId: payment.salesOrderId });
  }
  if (payment.status === 'CONFIRMED') {
    return fail('INVALID_STATE_TRANSITION', 'A confirmed payment cannot be rejected.');
  }
  if (!reason.trim()) {
    return fail('VALIDATION_FAILED', 'Say why the evidence is being rejected.');
  }

  await tx.payment.update({
    where: { id: paymentId },
    data: {
      status: 'REJECTED',
      reviewedById: context.userId,
      reviewedAt: new Date(),
      rejectionReason: reason.trim(),
    },
  });

  await recordAudit(tx, context, {
    action: 'payment.rejected',
    entityType: 'payment',
    entityId: paymentId,
    oldState: { status: payment.status },
    newState: { status: 'REJECTED', reason: reason.trim() },
    approvalStatus: 'REJECTED',
  });

  return ok({ alreadyRejected: false, salesOrderId: payment.salesOrderId });
}
