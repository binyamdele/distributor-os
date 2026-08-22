'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import {
  cancelDiscrepancy,
  cancelReturn,
  completeReturn,
  createDeliveryRetry,
  createReturn,
  inspectReturn,
  receiveReturn,
  reconcileDiscrepancy,
  reportDiscrepancy,
  resolveDeliveryLoss,
  resolveReservationShortfall,
  reviewDiscrepancy,
} from '@/modules/inventory';

/**
 * The HTTP edge of the exception workflows.
 *
 * Every action re-checks its own permission server-side. The separations Phase 7 introduces —
 * counting is not correcting, and the warehouse does not choose whose order gives way — only
 * mean anything if each action asks for the permission it actually needs. Hiding a button is a
 * courtesy; this is the control.
 */

export interface ExceptionFormState {
  readonly error?: string;
  readonly ok?: boolean;
  /** Present when a reconciliation was refused because the yard cannot cover its promises. */
  readonly shortfall?: number;
}

export async function reportAction(
  productId: string,
  warehouseTaskId: string | null,
  redirectTo: string | null,
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  const session = await requirePermission('report:inventory-discrepancy');

  const result = await withTenant(session.organizationId, (tx) =>
    reportDiscrepancy(tx, actorFrom(session), {
      productId,
      physicalCount: formData.get('physicalCount'),
      warehouseTaskId: warehouseTaskId ?? '',
      note: formData.get('note') ?? '',
    }),
  );

  revalidatePath('/exceptions');
  if (warehouseTaskId) revalidatePath(`/warehouse/${warehouseTaskId}`);

  if (!result.ok) return { error: result.error.message };
  redirect(redirectTo ?? `/exceptions/${result.value.id}`);
}

export async function reviewAction(
  discrepancyId: string,
  _previous: ExceptionFormState,
): Promise<ExceptionFormState> {
  const session = await requirePermission('review:inventory-discrepancy');

  const result = await withTenant(session.organizationId, (tx) =>
    reviewDiscrepancy(tx, actorFrom(session), discrepancyId),
  );

  revalidatePath('/exceptions');
  revalidatePath(`/exceptions/${discrepancyId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function reconcileAction(
  discrepancyId: string,
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  const session = await requirePermission('resolve:inventory-discrepancy');

  const result = await withTenant(session.organizationId, (tx) =>
    reconcileDiscrepancy(
      tx,
      actorFrom(session),
      discrepancyId,
      String(formData.get('note') ?? '') || null,
    ),
  );

  revalidatePath('/exceptions');
  revalidatePath(`/exceptions/${discrepancyId}`);
  revalidatePath('/products');
  revalidatePath('/warehouse');

  if (!result.ok) {
    return {
      error: result.error.message,
      shortfall:
        result.error.details?.refusal === 'RESERVATION_SHORTFALL' ? 1 : undefined,
    };
  }
  return { ok: true };
}

export async function withdrawDiscrepancyAction(
  discrepancyId: string,
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  const session = await requirePermission('resolve:inventory-discrepancy');

  const result = await withTenant(session.organizationId, (tx) =>
    cancelDiscrepancy(
      tx,
      actorFrom(session),
      discrepancyId,
      String(formData.get('reason') ?? ''),
    ),
  );

  revalidatePath('/exceptions');
  revalidatePath(`/exceptions/${discrepancyId}`);
  revalidatePath('/warehouse');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

/**
 * Reduces one named order's reservation.
 *
 * Gated on its own permission, held only by a sales manager and the owner. A warehouse user who
 * reported the count cannot reach this — establishing what is on the shelf and deciding which
 * customer does without are different jobs.
 */
export async function reduceReservationAction(
  discrepancyId: string,
  reservationId: string,
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  const session = await requirePermission('resolve:reservation-shortfall');

  const result = await withTenant(session.organizationId, (tx) =>
    resolveReservationShortfall(
      tx,
      actorFrom(session),
      reservationId,
      Number(formData.get('newQuantity') ?? 0),
      String(formData.get('reason') ?? ''),
    ),
  );

  revalidatePath('/exceptions');
  revalidatePath(`/exceptions/${discrepancyId}`);
  revalidatePath('/orders');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Failed-delivery resolution
// ---------------------------------------------------------------------------

export async function retryAction(
  deliveryId: string,
  _previous: ExceptionFormState,
): Promise<ExceptionFormState> {
  const session = await requirePermission('create:delivery-retry');

  const result = await withTenant(session.organizationId, (tx) =>
    createDeliveryRetry(tx, actorFrom(session), deliveryId),
  );

  revalidatePath('/exceptions');
  revalidatePath('/deliveries');
  revalidatePath(`/deliveries/${deliveryId}`);

  if (!result.ok) return { error: result.error.message };
  redirect(`/deliveries/${result.value.id}`);
}

export async function returnAction(
  deliveryId: string,
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  const session = await requirePermission('create:return');

  const result = await withTenant(session.organizationId, (tx) =>
    createReturn(tx, actorFrom(session), deliveryId, String(formData.get('note') ?? '') || null),
  );

  revalidatePath('/exceptions');
  revalidatePath('/returns');
  revalidatePath(`/deliveries/${deliveryId}`);

  if (!result.ok) return { error: result.error.message };
  redirect(`/returns/${result.value.id}`);
}

export async function lossAction(
  deliveryId: string,
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  const session = await requirePermission('resolve:delivery-loss');

  const result = await withTenant(session.organizationId, (tx) =>
    resolveDeliveryLoss(tx, actorFrom(session), deliveryId, String(formData.get('note') ?? '')),
  );

  revalidatePath('/exceptions');
  revalidatePath('/deliveries');
  revalidatePath(`/deliveries/${deliveryId}`);
  revalidatePath('/orders');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export async function receiveAction(
  returnId: string,
  _previous: ExceptionFormState,
): Promise<ExceptionFormState> {
  const session = await requirePermission('receive:return');

  const result = await withTenant(session.organizationId, (tx) =>
    receiveReturn(tx, actorFrom(session), returnId),
  );

  revalidatePath('/returns');
  revalidatePath(`/returns/${returnId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function inspectAction(
  returnId: string,
  itemIds: readonly string[],
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  const session = await requirePermission('inspect:return');

  const lines = itemIds.map((itemId) => ({
    itemId,
    received: formData.get(`received-${itemId}`) ?? 0,
    restockable: formData.get(`restockable-${itemId}`) ?? 0,
    damaged: formData.get(`damaged-${itemId}`) ?? 0,
    note: formData.get(`note-${itemId}`) ?? '',
  }));

  const result = await withTenant(session.organizationId, (tx) =>
    inspectReturn(tx, actorFrom(session), returnId, lines),
  );

  revalidatePath('/returns');
  revalidatePath(`/returns/${returnId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function completeReturnAction(
  returnId: string,
  _previous: ExceptionFormState,
): Promise<ExceptionFormState> {
  const session = await requirePermission('complete:return');

  const result = await withTenant(session.organizationId, (tx) =>
    completeReturn(tx, actorFrom(session), returnId),
  );

  revalidatePath('/returns');
  revalidatePath(`/returns/${returnId}`);
  revalidatePath('/products');
  revalidatePath('/exceptions');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function withdrawReturnAction(
  returnId: string,
  _previous: ExceptionFormState,
  formData: FormData,
): Promise<ExceptionFormState> {
  const session = await requirePermission('create:return');

  const result = await withTenant(session.organizationId, (tx) =>
    cancelReturn(tx, actorFrom(session), returnId, String(formData.get('reason') ?? '')),
  );

  revalidatePath('/returns');
  revalidatePath(`/returns/${returnId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}
