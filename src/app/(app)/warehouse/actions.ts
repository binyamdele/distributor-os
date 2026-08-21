'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import {
  type ConsumptionMismatch,
  cancelWarehouseTask,
  completeWarehouseTask,
  createWarehouseTask,
  markItemPrepared,
  markTaskPrepared,
  recordPickup,
  startWarehouseTask,
} from '@/modules/fulfillment';

/**
 * The HTTP edge of the warehouse workflow.
 *
 * Every action re-checks its own permission server-side. The four warehouse permissions are
 * distinct rather than one `manage:warehouse`, and the distinction only means anything if each
 * action asks for the one it needs — hiding a button is a courtesy, this is the control.
 */

export interface WarehouseFormState {
  readonly error?: string;
  readonly ok?: boolean;
  /** Present only on a reservation mismatch, so the screen can name products and quantities. */
  readonly mismatches?: ConsumptionMismatch[];
}

export async function createTaskAction(
  salesOrderId: string,
  _previous: WarehouseFormState,
): Promise<WarehouseFormState> {
  const session = await requirePermission('create:warehouse-task');

  const result = await withTenant(session.organizationId, (tx) =>
    createWarehouseTask(tx, actorFrom(session), salesOrderId),
  );

  revalidatePath('/warehouse');
  revalidatePath(`/orders/${salesOrderId}`);

  if (!result.ok) return { error: result.error.message };
  redirect(`/warehouse/${result.value.id}`);
}

export async function startTaskAction(
  taskId: string,
  _previous: WarehouseFormState,
): Promise<WarehouseFormState> {
  const session = await requirePermission('start:warehouse-task');

  const result = await withTenant(session.organizationId, (tx) =>
    startWarehouseTask(tx, actorFrom(session), taskId),
  );

  revalidatePath('/warehouse');
  revalidatePath(`/warehouse/${taskId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function toggleItemAction(
  taskId: string,
  itemId: string,
  prepared: boolean,
  _previous: WarehouseFormState,
): Promise<WarehouseFormState> {
  const session = await requirePermission('prepare:warehouse-task');

  const result = await withTenant(session.organizationId, (tx) =>
    markItemPrepared(tx, actorFrom(session), taskId, itemId, prepared),
  );

  revalidatePath(`/warehouse/${taskId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function markPreparedAction(
  taskId: string,
  _previous: WarehouseFormState,
): Promise<WarehouseFormState> {
  const session = await requirePermission('prepare:warehouse-task');

  const result = await withTenant(session.organizationId, (tx) =>
    markTaskPrepared(tx, actorFrom(session), taskId),
  );

  revalidatePath('/warehouse');
  revalidatePath(`/warehouse/${taskId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

/**
 * The handoff — the only action in the product that consumes stock.
 *
 * A reservation mismatch comes back as structured data rather than a sentence, because the
 * person holding the trolley needs a product name and two numbers to act on.
 */
export async function completeTaskAction(
  taskId: string,
  _previous: WarehouseFormState,
): Promise<WarehouseFormState> {
  const session = await requirePermission('complete:warehouse-task');

  const result = await withTenant(session.organizationId, (tx) =>
    completeWarehouseTask(tx, actorFrom(session), taskId),
  );

  revalidatePath('/warehouse');
  revalidatePath(`/warehouse/${taskId}`);
  revalidatePath('/deliveries');
  revalidatePath('/products');
  revalidatePath('/orders');

  if (!result.ok) {
    const mismatches = result.error.details?.mismatches;
    return {
      error: result.error.message,
      mismatches: Array.isArray(mismatches) ? (mismatches as ConsumptionMismatch[]) : undefined,
    };
  }

  return { ok: true };
}

export async function cancelTaskAction(
  taskId: string,
  _previous: WarehouseFormState,
  formData: FormData,
): Promise<WarehouseFormState> {
  const session = await requirePermission('cancel:warehouse-task');

  const result = await withTenant(session.organizationId, (tx) =>
    cancelWarehouseTask(tx, actorFrom(session), taskId, String(formData.get('reason') ?? '')),
  );

  revalidatePath('/warehouse');
  revalidatePath(`/warehouse/${taskId}`);

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}

export async function recordPickupAction(
  taskId: string,
  salesOrderId: string,
  _previous: WarehouseFormState,
  formData: FormData,
): Promise<WarehouseFormState> {
  const session = await requirePermission('record:pickup');

  const result = await withTenant(session.organizationId, (tx) =>
    recordPickup(tx, actorFrom(session), salesOrderId, String(formData.get('note') ?? '') || null),
  );

  revalidatePath(`/warehouse/${taskId}`);
  revalidatePath(`/orders/${salesOrderId}`);
  revalidatePath('/orders');

  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}
