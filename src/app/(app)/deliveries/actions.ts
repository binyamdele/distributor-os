'use server';

import { revalidatePath } from 'next/cache';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import {
  type DeliveryFailureReason,
  assignDelivery,
  completeDelivery,
  dispatchDelivery,
  failDelivery,
} from '@/modules/fulfillment';

export interface DeliveryFormState {
  readonly error?: string;
  readonly ok?: boolean;
}

export async function assignAction(
  deliveryId: string,
  _previous: DeliveryFormState,
  formData: FormData,
): Promise<DeliveryFormState> {
  const session = await requirePermission('assign:delivery');

  const result = await withTenant(session.organizationId, (tx) =>
    assignDelivery(tx, actorFrom(session), deliveryId, {
      driverName: formData.get('driverName'),
      driverPhone: formData.get('driverPhone') ?? '',
      vehicleReference: formData.get('vehicleReference') ?? '',
    }),
  );

  revalidatePath('/deliveries');
  revalidatePath(`/deliveries/${deliveryId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function dispatchAction(
  deliveryId: string,
  _previous: DeliveryFormState,
): Promise<DeliveryFormState> {
  const session = await requirePermission('dispatch:delivery');

  const result = await withTenant(session.organizationId, (tx) =>
    dispatchDelivery(tx, actorFrom(session), deliveryId),
  );

  revalidatePath('/deliveries');
  revalidatePath(`/deliveries/${deliveryId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function completeAction(
  deliveryId: string,
  _previous: DeliveryFormState,
  formData: FormData,
): Promise<DeliveryFormState> {
  const session = await requirePermission('complete:delivery');

  const result = await withTenant(session.organizationId, (tx) =>
    completeDelivery(
      tx,
      actorFrom(session),
      deliveryId,
      String(formData.get('note') ?? '') || null,
    ),
  );

  revalidatePath('/deliveries');
  revalidatePath(`/deliveries/${deliveryId}`);
  revalidatePath('/orders');
  revalidatePath('/receivables');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function failAction(
  deliveryId: string,
  _previous: DeliveryFormState,
  formData: FormData,
): Promise<DeliveryFormState> {
  const session = await requirePermission('fail:delivery');

  const result = await withTenant(session.organizationId, (tx) =>
    failDelivery(
      tx,
      actorFrom(session),
      deliveryId,
      String(formData.get('reason') ?? 'OTHER') as DeliveryFailureReason,
      String(formData.get('note') ?? '') || null,
    ),
  );

  revalidatePath('/deliveries');
  revalidatePath(`/deliveries/${deliveryId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}
