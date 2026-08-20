'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import {
  addManualItem,
  confirmItem,
  correctItemProduct,
  correctItemQuantity,
  createInquiry,
  markItemUnresolved,
  markReadyForQuote,
  rejectItem,
  runParse,
} from '@/modules/inquiries';

export interface InquiryFormState {
  readonly error?: string;
  readonly field?: string;
  readonly ok?: boolean;
}

export async function createInquiryAction(
  _previous: InquiryFormState,
  formData: FormData,
): Promise<InquiryFormState> {
  const session = await requirePermission('write:inquiry');

  const result = await withTenant(session.organizationId, (tx) =>
    createInquiry(tx, actorFrom(session), {
      rawMessage: formData.get('rawMessage'),
      channel: formData.get('channel') || 'MANUAL',
      customerId: formData.get('customerId') || '',
    }),
  );

  if (!result.ok) {
    return { error: result.error.message, field: result.error.details?.field as string };
  }

  revalidatePath('/inquiries');
  redirect(`/inquiries/${result.value.id}`);
}

export async function parseInquiryAction(
  inquiryId: string,
  _previous: InquiryFormState,
  _formData: FormData,
): Promise<InquiryFormState> {
  const session = await requirePermission('parse:inquiry');

  // runParse manages its own transactions: the provider call must not hold a connection.
  const result = await runParse(session.organizationId, actorFrom(session), inquiryId);

  revalidatePath(`/inquiries/${inquiryId}`);
  revalidatePath('/inquiries');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

/** All per-item review actions share a shape, so they share a dispatcher. */
export async function reviewItemAction(
  inquiryId: string,
  _previous: InquiryFormState,
  formData: FormData,
): Promise<InquiryFormState> {
  const session = await requirePermission('review:inquiry-match');
  const actor = actorFrom(session);
  const itemId = String(formData.get('itemId') ?? '');
  const intent = String(formData.get('intent') ?? '');

  const result = await withTenant(session.organizationId, async (tx) => {
    switch (intent) {
      case 'confirm':
        return confirmItem(tx, actor, itemId);
      case 'correct':
        return correctItemProduct(tx, actor, itemId, String(formData.get('productId') ?? ''));
      case 'quantity':
        return correctItemQuantity(tx, actor, itemId, {
          quantity: formData.get('quantity'),
          unit: formData.get('unit'),
        });
      case 'unresolved':
        return markItemUnresolved(tx, actor, itemId);
      case 'reject':
        return rejectItem(tx, actor, itemId);
      case 'add':
        return addManualItem(tx, actor, inquiryId, {
          productId: formData.get('productId'),
          quantity: formData.get('quantity'),
        });
      default:
        return { ok: false as const, error: { code: 'VALIDATION_FAILED' as const, message: 'Unknown action.' } };
    }
  });

  revalidatePath(`/inquiries/${inquiryId}`);
  revalidatePath('/inquiries');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function markReadyAction(
  inquiryId: string,
  _previous: InquiryFormState,
  _formData: FormData,
): Promise<InquiryFormState> {
  const session = await requirePermission('mark:inquiry-ready');

  const result = await withTenant(session.organizationId, (tx) =>
    markReadyForQuote(tx, actorFrom(session), inquiryId),
  );

  revalidatePath(`/inquiries/${inquiryId}`);
  revalidatePath('/inquiries');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}
