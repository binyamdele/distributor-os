'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { type LineShortfall, cancelOrder, createFromQuotation } from '@/modules/orders';
import { recordAcceptance, recordRejection } from '@/modules/quotations';

export interface OrderFormState {
  readonly error?: string;
  readonly ok?: boolean;
  /** Present only on an INSUFFICIENT_STOCK refusal, so the UI can show exact numbers. */
  readonly shortfalls?: LineShortfall[];
}

export async function recordAcceptanceAction(
  quotationId: string,
  _previous: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  const session = await requirePermission('record:quotation-acceptance');

  const result = await withTenant(session.organizationId, (tx) =>
    recordAcceptance(tx, actorFrom(session), quotationId, {
      source: formData.get('source'),
      note: formData.get('note') ?? '',
    }),
  );

  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath('/follow-ups');
  revalidatePath('/quotations');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function recordRejectionAction(
  quotationId: string,
  _previous: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  const session = await requirePermission('record:quotation-rejection');

  const reason = String(formData.get('reason') ?? '');

  const result = await withTenant(session.organizationId, (tx) =>
    recordRejection(tx, actorFrom(session), quotationId, {
      reason: reason || undefined,
      note: formData.get('note') ?? '',
    }),
  );

  revalidatePath(`/quotations/${quotationId}`);
  revalidatePath('/follow-ups');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function createOrderAction(
  quotationId: string,
  _previous: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  const session = await requirePermission('create:sales-order');

  const result = await withTenant(session.organizationId, (tx) =>
    createFromQuotation(tx, actorFrom(session), {
      quotationId,
      deliveryRequired: formData.get('deliveryRequired') === 'on',
    }),
  );

  revalidatePath('/orders');
  revalidatePath(`/quotations/${quotationId}`);

  if (!result.ok) {
    // A shortfall is not a generic failure. The salesperson needs the numbers to have the
    // conversation with the customer, so they travel back with the refusal.
    return {
      error: result.error.message,
      shortfalls: (result.error.details?.shortfalls as LineShortfall[] | undefined) ?? undefined,
    };
  }

  redirect(`/orders/${result.value.id}`);
}

export async function cancelOrderAction(
  orderId: string,
  _previous: OrderFormState,
  formData: FormData,
): Promise<OrderFormState> {
  const session = await requirePermission('cancel:order');

  const result = await withTenant(session.organizationId, (tx) =>
    cancelOrder(tx, actorFrom(session), orderId, String(formData.get('reason') ?? '')),
  );

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}
