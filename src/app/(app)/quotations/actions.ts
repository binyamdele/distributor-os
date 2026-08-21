'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { parseDecimal } from '@/platform/money';
import {
  addLine,
  approve,
  cancelQuotation,
  createFromInquiry,
  markSent,
  reject,
  removeLine,
  setDeliveryFee,
  setLineDiscount,
  setLineQuantity,
  setNotes,
  setPaymentTerms,
  submitForApproval,
} from '@/modules/quotations';

export interface QuotationFormState {
  readonly error?: string;
  readonly ok?: boolean;
}

export async function createQuotationAction(
  inquiryId: string,
  _previous: QuotationFormState,
  formData: FormData,
): Promise<QuotationFormState> {
  const session = await requirePermission('create:quotation');

  const result = await withTenant(session.organizationId, (tx) =>
    createFromInquiry(tx, actorFrom(session), {
      inquiryId,
      paymentType: formData.get('paymentType') || 'CASH',
      paymentTermsDays: formData.get('paymentTermsDays') || 0,
    }),
  );

  if (!result.ok) return { error: result.error.message };

  revalidatePath('/quotations');
  revalidatePath(`/inquiries/${inquiryId}`);
  redirect(`/quotations/${result.value.id}`);
}

/** Every line-level and header-level edit, dispatched from one form handler. */
export async function editQuotationAction(
  quotationId: string,
  _previous: QuotationFormState,
  formData: FormData,
): Promise<QuotationFormState> {
  const session = await requirePermission('edit:quotation');
  const actor = actorFrom(session);
  const intent = String(formData.get('intent') ?? '');
  const lineId = String(formData.get('lineId') ?? '');

  const result = await withTenant(session.organizationId, async (tx) => {
    switch (intent) {
      case 'quantity':
        return setLineQuantity(tx, actor, quotationId, lineId, {
          quantity: formData.get('quantity'),
        });
      case 'discount': {
        // Entered as a percentage by a human; stored as basis points. Parsed through the money
        // module's decimal parser so "2.5" cannot become a float on the way in.
        const raw = String(formData.get('discountPercent') ?? '0').trim() || '0';
        const parsed = parseDecimal(raw, 'XXX');
        if (!parsed.ok) {
          return { ok: false as const, error: { code: 'VALIDATION_FAILED' as const, message: 'Enter a percentage such as 2.5' } };
        }
        return setLineDiscount(tx, actor, quotationId, lineId, {
          discountBp: Number(parsed.value.amountMinor),
        });
      }
      case 'removeLine':
        return removeLine(tx, actor, quotationId, lineId);
      case 'addLine':
        return addLine(tx, actor, quotationId, {
          productId: formData.get('productId'),
          quantity: formData.get('quantity'),
        });
      case 'deliveryFee': {
        const parsed = parseDecimal(String(formData.get('deliveryFee') ?? '0') || '0', session.currency);
        if (!parsed.ok) return parsed;
        return setDeliveryFee(tx, actor, quotationId, parsed.value.amountMinor);
      }
      case 'paymentTerms':
        return setPaymentTerms(tx, actor, quotationId, {
          paymentType: formData.get('paymentType'),
          paymentTermsDays: formData.get('paymentTermsDays') ?? 0,
        });
      case 'notes':
        return setNotes(tx, actor, quotationId, {
          customerNotes: String(formData.get('customerNotes') ?? '') || null,
          internalNotes: String(formData.get('internalNotes') ?? '') || null,
        });
      default:
        return { ok: false as const, error: { code: 'VALIDATION_FAILED' as const, message: 'Unknown action.' } };
    }
  });

  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath('/quotations');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function submitQuotationAction(
  quotationId: string,
  _previous: QuotationFormState,
  _formData: FormData,
): Promise<QuotationFormState> {
  const session = await requirePermission('submit:quotation');

  const result = await withTenant(session.organizationId, (tx) =>
    submitForApproval(tx, actorFrom(session), quotationId),
  );

  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath('/quotations');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function approveQuotationAction(
  quotationId: string,
  _previous: QuotationFormState,
  formData: FormData,
): Promise<QuotationFormState> {
  // The lower of the two approval permissions is the entry ticket; the rules engine then
  // decides whether this particular quotation is within this particular role's authority.
  const session = await requirePermission('approve:quotation:self_limit');

  const result = await withTenant(session.organizationId, (tx) =>
    approve(tx, actorFrom(session), quotationId, {
      // The hash the approver was actually shown. If the figures moved while they were
      // reading, they are told so rather than approving something else.
      expectedPayloadHash: String(formData.get('expectedPayloadHash') ?? '') || undefined,
    }),
  );

  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath('/quotations');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function rejectQuotationAction(
  quotationId: string,
  _previous: QuotationFormState,
  formData: FormData,
): Promise<QuotationFormState> {
  const session = await requirePermission('approve:quotation:self_limit');

  const result = await withTenant(session.organizationId, (tx) =>
    reject(tx, actorFrom(session), quotationId, String(formData.get('reason') ?? '')),
  );

  revalidatePath(`/quotations/${quotationId}`);
  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function markSentAction(
  quotationId: string,
  _previous: QuotationFormState,
  _formData: FormData,
): Promise<QuotationFormState> {
  const session = await requirePermission('mark:quotation-sent');

  const result = await withTenant(session.organizationId, (tx) =>
    markSent(tx, actorFrom(session), quotationId),
  );

  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath('/quotations');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function cancelQuotationAction(
  quotationId: string,
  _previous: QuotationFormState,
  formData: FormData,
): Promise<QuotationFormState> {
  const session = await requirePermission('edit:quotation');

  const result = await withTenant(session.organizationId, (tx) =>
    cancelQuotation(tx, actorFrom(session), quotationId, String(formData.get('reason') ?? '')),
  );

  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath('/quotations');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}
