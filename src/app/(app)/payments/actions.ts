'use server';

import { revalidatePath } from 'next/cache';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import {
  assessPayment,
  confirmPayment,
  correctPaymentMetadata,
  rejectPayment,
  runExtraction,
  submitPayment,
} from '@/modules/payments';
import { MAX_EVIDENCE_BYTES } from '@/platform/storage';

/**
 * The HTTP edge of the payment gate.
 *
 * Two things are load-bearing here and neither is visible in the UI:
 *
 *   1. Every action re-checks its permission server-side. `submit:payment-evidence` and
 *      `confirm:payment` are held by different roles, so the separation between claiming that
 *      money arrived and deciding that it did survives someone posting the form directly.
 *
 *   2. Confirmation carries the payload hash the reviewer was shown. If anything moved between
 *      the screen rendering and the button being pressed, the module refuses rather than
 *      confirming figures nobody looked at.
 */

export interface PaymentFormState {
  readonly error?: string;
  readonly ok?: boolean;
  /** Set when the refusal was a blocking match factor, so the screen can point at it. */
  readonly factors?: string[];
}

export async function submitPaymentAction(
  salesOrderId: string,
  _previous: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const session = await requirePermission('submit:payment-evidence');

  // Read the upload as bytes. The browser's declared type is carried along only so the
  // validator can compare it against what the bytes actually are.
  const file = formData.get('evidence');
  let evidence: { bytes: Uint8Array; claimedMimeType: string | null; filename: string | null } | undefined;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_EVIDENCE_BYTES) {
      return { error: 'That file is larger than 10 MB.' };
    }
    evidence = {
      bytes: new Uint8Array(await file.arrayBuffer()),
      claimedMimeType: file.type || null,
      filename: file.name || null,
    };
  }

  const result = await withTenant(session.organizationId, (tx) =>
    submitPayment(
      tx,
      actorFrom(session),
      {
        salesOrderId,
        amountClaimed: formData.get('amountClaimed'),
        method: formData.get('method'),
        providerName: formData.get('providerName') ?? '',
        transactionReference: formData.get('transactionReference') ?? '',
        payerName: formData.get('payerName') ?? '',
        paymentDate: formData.get('paymentDate') ?? '',
      },
      evidence,
    ),
  );

  if (!result.ok) return { error: result.error.message };

  // Reading the receipt happens after the claim is safely recorded, and its failure is not the
  // submitter's problem — the payment sits in the queue either way.
  if (result.value.evidenceFileId) {
    await runExtraction(session.organizationId, actorFrom(session), result.value.id);
  }

  revalidatePath(`/orders/${salesOrderId}`);
  revalidatePath('/payments');
  return { ok: true };
}

export async function extractAction(
  paymentId: string,
  _previous: PaymentFormState,
): Promise<PaymentFormState> {
  const session = await requirePermission('review:payment');

  const result = await runExtraction(session.organizationId, actorFrom(session), paymentId);

  revalidatePath(`/payments/${paymentId}`);
  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function correctAction(
  paymentId: string,
  _previous: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const session = await requirePermission('review:payment');

  const result = await withTenant(session.organizationId, (tx) =>
    correctPaymentMetadata(tx, actorFrom(session), paymentId, {
      amountClaimed: formData.get('amountClaimed'),
      method: formData.get('method'),
      providerName: formData.get('providerName') ?? '',
      transactionReference: formData.get('transactionReference') ?? '',
      payerName: formData.get('payerName') ?? '',
      paymentDate: formData.get('paymentDate') ?? '',
    }),
  );

  revalidatePath(`/payments/${paymentId}`);
  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function confirmAction(
  paymentId: string,
  _previous: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const session = await requirePermission('confirm:payment');

  const expectedPayloadHash = String(formData.get('payloadHash') ?? '') || undefined;

  const result = await withTenant(session.organizationId, (tx) =>
    confirmPayment(tx, actorFrom(session), paymentId, { expectedPayloadHash }),
  );

  revalidatePath(`/payments/${paymentId}`);
  revalidatePath('/payments');
  revalidatePath('/receivables');
  revalidatePath('/orders');

  if (!result.ok) {
    const factors = result.error.details?.factors;
    return {
      error: result.error.message,
      factors: Array.isArray(factors) ? factors.map(String) : undefined,
    };
  }

  // The order screen is the one that now says something different — Paid, Part paid, Ready.
  // Leaving it cached would show "Unpaid" against money that has been confirmed.
  revalidatePath(`/orders/${result.value.salesOrderId}`);
  return { ok: true };
}

export async function rejectAction(
  paymentId: string,
  _previous: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const session = await requirePermission('reject:payment');

  const result = await withTenant(session.organizationId, (tx) =>
    rejectPayment(tx, actorFrom(session), paymentId, String(formData.get('reason') ?? '')),
  );

  revalidatePath(`/payments/${paymentId}`);
  revalidatePath('/payments');

  if (!result.ok) return { error: result.error.message };

  revalidatePath(`/orders/${result.value.salesOrderId}`);
  return { ok: true };
}

/** Re-derives the assessment for a screen that is about to offer a Confirm button. */
export async function currentAssessment(paymentId: string) {
  const session = await requirePermission('review:payment');
  return withTenant(session.organizationId, (tx) =>
    assessPayment(tx, session.organizationId, paymentId),
  );
}
