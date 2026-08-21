import 'server-only';
import { z } from 'zod';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { isUuid } from '@/platform/ids';
import { type Result, fail, ok } from '@/platform/result';
import { recordAudit } from '@/modules/audit';

/**
 * Quotation follow-ups.
 *
 * A follow-up is a task on a salesperson's list, not an autonomous agent. Nothing in this
 * module sends anything, and nothing in it calls a model — the queue works with the AI provider
 * unreachable, which matters because chasing quotations is the part of the workflow a
 * distributor cannot afford to have degrade.
 *
 * The queue is a query rather than a scheduler. A follow-up is due when its `dueAt` has passed
 * and it is still `DUE`; there is no cron, no worker and nothing to fall over at 3am.
 */

export const FOLLOW_UP_STATUSES = ['DUE', 'COMPLETED', 'SNOOZED', 'CANCELLED'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const FOLLOW_UP_OUTCOMES = [
  'NO_RESPONSE',
  'CUSTOMER_CONSIDERING',
  'CUSTOMER_REQUESTED_CHANGE',
  'CUSTOMER_ACCEPTED',
  'CUSTOMER_REJECTED',
  'OTHER',
] as const;
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

/**
 * Permitted transitions.
 *
 * `COMPLETED` and `CANCELLED` are terminal: a follow-up records one attempt, and a second
 * attempt is a second row. Reopening one would lose the history the table exists to keep.
 */
const TRANSITIONS: Readonly<Record<FollowUpStatus, readonly FollowUpStatus[]>> = {
  DUE: ['COMPLETED', 'SNOOZED', 'CANCELLED'],
  SNOOZED: ['DUE', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: FollowUpStatus, to: FollowUpStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isOpen(status: FollowUpStatus): boolean {
  return status === 'DUE' || status === 'SNOOZED';
}

/** The due date for the nth chase, counted from when the quotation was sent. */
export function dueDateFor(sentAt: Date, sequence: number, intervalDays: number): Date {
  const due = new Date(sentAt.getTime());
  due.setUTCDate(due.getUTCDate() + intervalDays * sequence);
  return due;
}

/** Whether another chase may be scheduled. A cap, not a loop. */
export function mayScheduleAnother(completedSequence: number, maxFollowUpCount: number): boolean {
  return completedSequence < maxFollowUpCount;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Schedules the first chase for a freshly sent quotation.
 *
 * Called from inside `markSent`'s transaction, so a quotation cannot be recorded as sent without
 * appearing in the queue — which is the failure mode the queue exists to prevent.
 */
export async function scheduleFirstFollowUp(
  tx: TenantTransaction,
  context: ActorContext,
  input: {
    quotationId: string;
    sentAt: Date;
    intervalDays: number;
    assignedUserId: string | null;
  },
): Promise<Result<{ id: string; dueAt: Date }>> {
  const existing = await tx.quotationFollowUp.count({ where: { quotationId: input.quotationId } });
  if (existing > 0) {
    // Re-sending is not a Phase 3 path, but scheduling twice would double the queue entry.
    return fail('CONFLICT', 'This quotation already has follow-ups scheduled.');
  }

  const dueAt = dueDateFor(input.sentAt, 1, input.intervalDays);

  const created = await tx.quotationFollowUp.create({
    data: {
      organizationId: context.organizationId,
      quotationId: input.quotationId,
      sequence: 1,
      dueAt,
      status: 'DUE',
      assignedUserId: input.assignedUserId,
    },
  });

  await recordAudit(tx, context, {
    action: 'followup.created',
    entityType: 'quotation_follow_up',
    entityId: created.id,
    newState: { quotationId: input.quotationId, sequence: 1, dueAt: dueAt.toISOString() },
  });

  return ok({ id: created.id, dueAt });
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export const completeFollowUpSchema = z.object({
  outcome: z.enum(FOLLOW_UP_OUTCOMES),
  note: z.string().trim().max(1000).optional().or(z.literal('')),
  /**
   * Whether to schedule the next chase.
   *
   * An explicit choice rather than an automatic consequence. A system that keeps generating
   * follow-ups by itself trains salespeople to ignore the queue, which costs more than the
   * chases are worth. The organization's `maxFollowUpCount` caps it regardless.
   */
  scheduleNext: z.coerce.boolean().default(false),
});

export interface CompletionResult {
  readonly nextFollowUpId: string | null;
  readonly nextDueAt: Date | null;
  readonly capReached: boolean;
}

export async function completeFollowUp(
  tx: TenantTransaction,
  context: ActorContext,
  followUpId: string,
  raw: unknown,
): Promise<Result<CompletionResult>> {
  const parsed = completeFollowUpSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', 'Choose an outcome for this follow-up.');
  }

  if (!isUuid(followUpId)) return fail('NOT_FOUND', 'error.notFound');

  const followUp = await tx.quotationFollowUp.findFirst({
    where: { id: followUpId },
    include: {
      quotation: {
        select: {
          id: true,
          status: true,
          sentAt: true,
          organizationId: true,
        },
      },
    },
  });
  if (!followUp) return fail('NOT_FOUND', 'error.notFound');

  const status = followUp.status as FollowUpStatus;
  if (!canTransition(status, 'COMPLETED')) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `This follow-up is already ${status.toLowerCase()}.`,
    );
  }

  await tx.quotationFollowUp.update({
    where: { id: followUpId },
    data: {
      status: 'COMPLETED',
      outcome: parsed.data.outcome,
      note: parsed.data.note?.trim() || null,
      completedAt: new Date(),
      completedById: context.userId,
    },
  });

  await recordAudit(tx, context, {
    action: 'followup.completed',
    entityType: 'quotation_follow_up',
    entityId: followUpId,
    oldState: { status, sequence: followUp.sequence },
    newState: { status: 'COMPLETED', outcome: parsed.data.outcome },
  });

  // Only a quotation still awaiting an answer gets chased again. One that has been accepted or
  // rejected is settled, and the acceptance path has already closed its open follow-ups.
  if (!parsed.data.scheduleNext || followUp.quotation.status !== 'SENT') {
    return ok({ nextFollowUpId: null, nextDueAt: null, capReached: false });
  }

  const settings = await tx.organizationSettings.findFirst({
    where: { organizationId: context.organizationId },
  });
  const maxCount = settings?.maxFollowUpCount ?? 4;
  const intervalDays = settings?.followUpIntervalDays ?? 2;

  if (!mayScheduleAnother(followUp.sequence, maxCount)) {
    return ok({ nextFollowUpId: null, nextDueAt: null, capReached: true });
  }

  const nextSequence = followUp.sequence + 1;
  const anchor = followUp.quotation.sentAt ?? followUp.dueAt;
  const nextDueAt = dueDateFor(anchor, nextSequence, intervalDays);

  const next = await tx.quotationFollowUp.create({
    data: {
      organizationId: context.organizationId,
      quotationId: followUp.quotationId,
      sequence: nextSequence,
      dueAt: nextDueAt,
      status: 'DUE',
      assignedUserId: followUp.assignedUserId,
    },
  });

  await recordAudit(tx, context, {
    action: 'followup.created',
    entityType: 'quotation_follow_up',
    entityId: next.id,
    newState: {
      quotationId: followUp.quotationId,
      sequence: nextSequence,
      dueAt: nextDueAt.toISOString(),
      scheduledAfter: followUpId,
    },
  });

  return ok({ nextFollowUpId: next.id, nextDueAt, capReached: false });
}

export const snoozeSchema = z.object({ days: z.coerce.number().int().min(1).max(30) });

export async function snoozeFollowUp(
  tx: TenantTransaction,
  context: ActorContext,
  followUpId: string,
  raw: unknown,
): Promise<Result<{ dueAt: Date }>> {
  const parsed = snoozeSchema.safeParse(raw);
  if (!parsed.success) return fail('VALIDATION_FAILED', 'Snooze for between 1 and 30 days.');

  const followUp = await tx.quotationFollowUp.findFirst({ where: { id: followUpId } });
  if (!followUp) return fail('NOT_FOUND', 'error.notFound');
  if (!canTransition(followUp.status as FollowUpStatus, 'SNOOZED')) {
    return fail('INVALID_STATE_TRANSITION', 'This follow-up can no longer be snoozed.');
  }

  const dueAt = new Date(Date.now() + parsed.data.days * 24 * 60 * 60 * 1000);
  await tx.quotationFollowUp.update({
    where: { id: followUpId },
    data: { status: 'SNOOZED', dueAt },
  });

  await recordAudit(tx, context, {
    action: 'followup.snoozed',
    entityType: 'quotation_follow_up',
    entityId: followUpId,
    oldState: { dueAt: followUp.dueAt.toISOString() },
    newState: { dueAt: dueAt.toISOString(), days: parsed.data.days },
  });

  return ok({ dueAt });
}

/**
 * Closes every open follow-up for a quotation.
 *
 * Called in the same transaction as acceptance and rejection. A salesperson must never be asked
 * to chase a quotation the customer has already answered — it wastes the call and it makes the
 * queue look untrustworthy, which is how queues stop being used.
 */
export async function cancelOpenFollowUps(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  reason: string,
): Promise<number> {
  const open = await tx.quotationFollowUp.findMany({
    where: { quotationId, status: { in: ['DUE', 'SNOOZED'] } },
  });

  for (const followUp of open) {
    await tx.quotationFollowUp.update({
      where: { id: followUp.id },
      data: { status: 'CANCELLED' },
    });
    await recordAudit(tx, context, {
      action: 'followup.cancelled',
      entityType: 'quotation_follow_up',
      entityId: followUp.id,
      oldState: { status: followUp.status },
      newState: { status: 'CANCELLED', reason },
    });
  }

  return open.length;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface FollowUpQueueRow {
  readonly id: string;
  readonly quotationId: string;
  readonly quotationNumber: string;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly grandTotalMinor: bigint;
  readonly currency: string;
  readonly sentAt: Date | null;
  readonly daysSinceSent: number | null;
  readonly sequence: number;
  readonly dueAt: Date;
  readonly status: FollowUpStatus;
  readonly assignedUserId: string | null;
  readonly overdue: boolean;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * The follow-up queue: overdue first, then due today, then upcoming.
 *
 * Ordering is by due date, oldest first. Deliberately not "prioritised" by anything cleverer —
 * a model ranking a sales queue at MVP would be unexplainable to the person working it, and the
 * honest ordering is the one they would use themselves.
 */
export async function followUpQueue(
  tx: TenantTransaction,
  options: { includeUpcoming?: boolean; now?: Date } = {},
): Promise<FollowUpQueueRow[]> {
  const now = options.now ?? new Date();

  const rows = await tx.quotationFollowUp.findMany({
    where: {
      status: { in: ['DUE', 'SNOOZED'] },
      // A follow-up only makes sense while the quotation is still awaiting an answer.
      quotation: { status: 'SENT' },
      ...(options.includeUpcoming ? {} : { dueAt: { lte: now } }),
    },
    orderBy: { dueAt: 'asc' },
    take: 200,
    include: {
      quotation: {
        select: {
          id: true,
          quotationNumber: true,
          grandTotalMinor: true,
          currency: true,
          sentAt: true,
          customer: { select: { companyName: true, phone: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    quotationId: row.quotation.id,
    quotationNumber: row.quotation.quotationNumber,
    customerName: row.quotation.customer.companyName,
    customerPhone: row.quotation.customer.phone,
    grandTotalMinor: row.quotation.grandTotalMinor,
    currency: row.quotation.currency,
    sentAt: row.quotation.sentAt,
    daysSinceSent: row.quotation.sentAt ? daysBetween(row.quotation.sentAt, now) : null,
    sequence: row.sequence,
    dueAt: row.dueAt,
    status: row.status as FollowUpStatus,
    assignedUserId: row.assignedUserId,
    overdue: row.dueAt < now,
  }));
}

export interface FollowUpRecord {
  readonly id: string;
  readonly sequence: number;
  readonly dueAt: Date;
  readonly status: FollowUpStatus;
  readonly outcome: FollowUpOutcome | null;
  readonly note: string | null;
  readonly completedAt: Date | null;
}

export async function followUpsFor(
  tx: TenantTransaction,
  quotationId: string,
): Promise<FollowUpRecord[]> {
  const rows = await tx.quotationFollowUp.findMany({
    where: { quotationId },
    orderBy: { sequence: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    dueAt: row.dueAt,
    status: row.status as FollowUpStatus,
    outcome: row.outcome as FollowUpOutcome | null,
    note: row.note,
    completedAt: row.completedAt,
  }));
}
