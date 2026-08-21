import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import { isUuid } from '@/platform/ids';
import { type Result, fail, ok } from '@/platform/result';
import { summariseBalance } from './balance';
import type { BalanceSummary } from './balance';
import type { MatchFactor } from './matching';
import type { PaymentStatus } from './index';

/** Reads for the verification queue and the review screen. */

export interface PaymentQueueRow {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly submittedAt: Date;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly currency: string;
  readonly amountClaimedMinor: bigint;
  readonly outstandingMinor: bigint;
  readonly method: string;
  readonly transactionReference: string | null;
  readonly hasEvidence: boolean;
  readonly extractionStatus: string;
  /** True when the claim does not equal the order's outstanding balance. */
  readonly amountDiffers: boolean;
}

/**
 * Payments waiting on Finance, oldest first.
 *
 * Oldest first because evidence that has been sitting longest is the customer most likely to be
 * chasing, and because any cleverer ordering would need justifying to the person working the
 * queue.
 */
export async function paymentsToVerify(tx: TenantTransaction): Promise<PaymentQueueRow[]> {
  const payments = await tx.payment.findMany({
    where: { status: { in: ['SUBMITTED', 'NEEDS_REVIEW'] } },
    orderBy: { submittedAt: 'asc' },
    take: 200,
    include: {
      customer: { select: { companyName: true } },
      salesOrder: {
        include: {
          payments: { where: { status: 'CONFIRMED' }, select: { amountConfirmedMinor: true } },
        },
      },
    },
  });

  return payments.map((payment) => {
    const balance = summariseBalance(
      payment.salesOrder.grandTotalMinor,
      payment.salesOrder.payments.map((confirmed) => ({
        amountConfirmedMinor: confirmed.amountConfirmedMinor ?? 0n,
      })),
      payment.salesOrder.currency,
    );

    return {
      id: payment.id,
      status: payment.status as PaymentStatus,
      submittedAt: payment.submittedAt,
      orderId: payment.salesOrderId,
      orderNumber: payment.salesOrder.orderNumber,
      customerName: payment.customer.companyName,
      currency: payment.currency,
      amountClaimedMinor: payment.amountClaimedMinor,
      outstandingMinor: balance.outstandingMinor,
      method: payment.method,
      transactionReference: payment.transactionReference,
      hasEvidence: payment.evidenceFileId !== null,
      extractionStatus: payment.extractionStatus,
      amountDiffers: payment.amountClaimedMinor !== balance.outstandingMinor,
    };
  });
}

export interface PaymentDetailView {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly amountClaimedMinor: bigint;
  readonly amountConfirmedMinor: bigint | null;
  readonly method: string;
  readonly providerName: string | null;
  readonly transactionReference: string | null;
  readonly payerName: string | null;
  readonly paymentDate: Date | null;
  readonly submittedAt: Date;
  readonly reviewedAt: Date | null;
  readonly rejectionReason: string | null;
  readonly extractionStatus: string;
  readonly extractionError: string | null;
  readonly confirmationPayloadHash: string | null;
  readonly evidence: {
    readonly id: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    /** Shown to Finance so a confirmation can be tied to specific bytes. */
    readonly contentHash: string;
    readonly originalFilename: string | null;
  } | null;
  readonly order: {
    readonly id: string;
    readonly orderNumber: string;
    readonly status: string;
    readonly paymentStatus: string;
    readonly fulfillmentStatus: string;
    readonly paymentType: string;
    readonly paymentTermsDays: number;
    readonly grandTotalMinor: bigint;
  };
  readonly customer: { readonly id: string; readonly companyName: string };
  readonly balance: BalanceSummary;
  readonly storedFactors: readonly MatchFactor[];
}

export async function getPayment(
  tx: TenantTransaction,
  paymentId: string,
): Promise<Result<PaymentDetailView>> {
  if (!isUuid(paymentId)) return fail('NOT_FOUND', 'error.notFound');

  const payment = await tx.payment.findFirst({
    where: { id: paymentId },
    include: {
      evidenceFile: true,
      customer: { select: { id: true, companyName: true } },
      salesOrder: {
        include: {
          payments: { where: { status: 'CONFIRMED' }, select: { amountConfirmedMinor: true } },
        },
      },
    },
  });
  if (!payment) return fail('NOT_FOUND', 'error.notFound');

  const balance = summariseBalance(
    payment.salesOrder.grandTotalMinor,
    payment.salesOrder.payments.map((confirmed) => ({
      amountConfirmedMinor: confirmed.amountConfirmedMinor ?? 0n,
    })),
    payment.salesOrder.currency,
  );

  return ok({
    id: payment.id,
    status: payment.status as PaymentStatus,
    currency: payment.currency,
    amountClaimedMinor: payment.amountClaimedMinor,
    amountConfirmedMinor: payment.amountConfirmedMinor,
    method: payment.method,
    providerName: payment.providerName,
    transactionReference: payment.transactionReference,
    payerName: payment.payerName,
    paymentDate: payment.paymentDate,
    submittedAt: payment.submittedAt,
    reviewedAt: payment.reviewedAt,
    rejectionReason: payment.rejectionReason,
    extractionStatus: payment.extractionStatus,
    extractionError: payment.extractionError,
    confirmationPayloadHash: payment.confirmationPayloadHash,
    evidence: payment.evidenceFile
      ? {
          id: payment.evidenceFile.id,
          mimeType: payment.evidenceFile.mimeType,
          sizeBytes: payment.evidenceFile.sizeBytes,
          contentHash: payment.evidenceFile.contentHash,
          originalFilename: payment.evidenceFile.originalFilename,
        }
      : null,
    order: {
      id: payment.salesOrder.id,
      orderNumber: payment.salesOrder.orderNumber,
      status: payment.salesOrder.status,
      paymentStatus: payment.salesOrder.paymentStatus,
      fulfillmentStatus: payment.salesOrder.fulfillmentStatus,
      paymentType: payment.salesOrder.paymentType,
      paymentTermsDays: payment.salesOrder.paymentTermsDays,
      grandTotalMinor: payment.salesOrder.grandTotalMinor,
    },
    customer: payment.customer,
    balance,
    storedFactors: Array.isArray(payment.matchFactors)
      ? (payment.matchFactors as unknown as MatchFactor[])
      : [],
  });
}

/** Payments recorded against one order, for the order screen. */
export async function paymentsForOrder(
  tx: TenantTransaction,
  salesOrderId: string,
): Promise<
  {
    id: string;
    status: PaymentStatus;
    amountClaimedMinor: bigint;
    amountConfirmedMinor: bigint | null;
    method: string;
    transactionReference: string | null;
    submittedAt: Date;
    reviewedAt: Date | null;
  }[]
> {
  if (!isUuid(salesOrderId)) return [];

  const rows = await tx.payment.findMany({
    where: { salesOrderId },
    orderBy: { submittedAt: 'asc' },
  });

  return rows.map((row) => ({
    id: row.id,
    status: row.status as PaymentStatus,
    amountClaimedMinor: row.amountClaimedMinor,
    amountConfirmedMinor: row.amountConfirmedMinor,
    method: row.method,
    transactionReference: row.transactionReference,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
  }));
}

/**
 * Resolves an evidence file for reading.
 *
 * Tenant-scoped, so a file id from another organization is simply not found. The caller must
 * also have checked the permission — a file id is never sufficient on its own.
 */
export async function evidenceForReading(
  tx: TenantTransaction,
  evidenceFileId: string,
): Promise<Result<{ storageKey: string; mimeType: string; contentHash: string }>> {
  if (!isUuid(evidenceFileId)) return fail('NOT_FOUND', 'error.notFound');

  const file = await tx.paymentEvidenceFile.findFirst({ where: { id: evidenceFileId } });
  if (!file) return fail('NOT_FOUND', 'error.notFound');
  return ok({
    storageKey: file.storageKey,
    mimeType: file.mimeType,
    contentHash: file.contentHash,
  });
}
