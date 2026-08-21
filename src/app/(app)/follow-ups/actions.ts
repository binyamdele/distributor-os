'use server';

import { revalidatePath } from 'next/cache';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { completeFollowUp, snoozeFollowUp } from '@/modules/followups';

export interface FollowUpFormState {
  readonly error?: string;
  readonly ok?: boolean;
  readonly capReached?: boolean;
}

export async function completeFollowUpAction(
  followUpId: string,
  _previous: FollowUpFormState,
  formData: FormData,
): Promise<FollowUpFormState> {
  const session = await requirePermission('complete:follow-up');

  const result = await withTenant(session.organizationId, (tx) =>
    completeFollowUp(tx, actorFrom(session), followUpId, {
      outcome: formData.get('outcome'),
      note: formData.get('note') ?? '',
      scheduleNext: formData.get('scheduleNext') === 'on',
    }),
  );

  revalidatePath('/follow-ups');
  revalidatePath('/quotations');

  if (!result.ok) return { error: result.error.message };
  return { ok: true, capReached: result.value.capReached };
}

export async function snoozeFollowUpAction(
  followUpId: string,
  _previous: FollowUpFormState,
  formData: FormData,
): Promise<FollowUpFormState> {
  const session = await requirePermission('complete:follow-up');

  const result = await withTenant(session.organizationId, (tx) =>
    snoozeFollowUp(tx, actorFrom(session), followUpId, { days: formData.get('days') ?? 1 }),
  );

  revalidatePath('/follow-ups');
  if (!result.ok) return { error: result.error.message };
  return { ok: true };
}
