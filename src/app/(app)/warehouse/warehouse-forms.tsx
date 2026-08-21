'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, Card, ErrorNote, Input } from '@/components/ui';
import { t } from '@/platform/i18n';
import {
  type WarehouseFormState,
  cancelTaskAction,
  completeTaskAction,
  createTaskAction,
  markPreparedAction,
  recordPickupAction,
  startTaskAction,
  toggleItemAction,
} from './actions';

function Submit({
  label,
  variant = 'secondary',
  testId,
}: {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  testId?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} data-testid={testId}>
      {label}
    </Button>
  );
}

export function CreateTaskForm({ salesOrderId }: { salesOrderId: string }) {
  const [state, formAction] = useActionState<WarehouseFormState, FormData>(
    createTaskAction.bind(null, salesOrderId),
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('wh.raise')} variant="primary" testId="raise-task-button" />
    </form>
  );
}

export function StartTaskForm({ taskId }: { taskId: string }) {
  const [state, formAction] = useActionState<WarehouseFormState, FormData>(
    startTaskAction.bind(null, taskId),
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('wh.start')} variant="primary" testId="start-task-button" />
    </form>
  );
}

/**
 * A line, picked or not. There is no quantity field.
 *
 * The absence is the design. Phase 6 has no partial fulfilment, and a box that accepts "8 of
 * 12" is a box that will eventually be used to ship 8 of 12. A line that cannot be picked in
 * full leaves the task unfinished and a person deals with it.
 */
export function ToggleItemForm({
  taskId,
  itemId,
  prepared,
}: {
  taskId: string;
  itemId: string;
  prepared: boolean;
}) {
  const [state, formAction] = useActionState<WarehouseFormState, FormData>(
    toggleItemAction.bind(null, taskId, itemId, !prepared),
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit
        label={prepared ? t('wh.unmarkLine') : t('wh.markLinePicked')}
        variant={prepared ? 'ghost' : 'secondary'}
        testId={prepared ? 'unpick-line' : 'pick-line'}
      />
    </form>
  );
}

export function MarkPreparedForm({ taskId }: { taskId: string }) {
  const [state, formAction] = useActionState<WarehouseFormState, FormData>(
    markPreparedAction.bind(null, taskId),
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('wh.markPrepared')} variant="primary" testId="mark-prepared-button" />
    </form>
  );
}

/**
 * The handoff.
 *
 * A refusal here is shown as a table of products and quantities, not a sentence, because it is
 * a discrepancy between the yard and the system and the person reading it has to go and count
 * something.
 */
export function CompleteTaskForm({ taskId }: { taskId: string }) {
  const [state, formAction] = useActionState<WarehouseFormState, FormData>(
    completeTaskAction.bind(null, taskId),
    {},
  );

  return (
    <div className="space-y-3">
      {state.mismatches && state.mismatches.length > 0 ? (
        <Card className="border-critical/30 bg-critical-soft" data-testid="reservation-mismatch">
          <h3 className="text-sm font-semibold text-critical">{t('wh.mismatch')}</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {state.mismatches.map((mismatch) => (
              <li key={`${mismatch.productId}-${mismatch.kind}`}>
                <div className="font-medium text-ink">
                  {mismatch.description}{' '}
                  <span className="font-mono text-xs text-ink-faint">{mismatch.sku}</span>
                </div>
                <div className="tabular mt-0.5 text-ink-muted">
                  {t('wh.required')}: {mismatch.expected.toLocaleString()} {mismatch.unit}
                  {' · '}
                  <span className="text-critical">
                    {t('wh.reserved')}: {mismatch.actual.toLocaleString()} {mismatch.unit}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-muted">
            Nothing has been changed. Count the shelf and correct the stock separately — a
            fulfilment must never adjust its own figures to succeed.
          </p>
        </Card>
      ) : state.error ? (
        <ErrorNote>{state.error}</ErrorNote>
      ) : null}

      <form action={formAction}>
        <Submit label={t('wh.complete')} variant="primary" testId="complete-task-button" />
      </form>
      <p className="text-xs text-ink-faint">{t('wh.completeHint')}</p>
    </div>
  );
}

export function CancelTaskForm({ taskId }: { taskId: string }) {
  const [state, formAction] = useActionState<WarehouseFormState, FormData>(
    cancelTaskAction.bind(null, taskId),
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      {state.error ? (
        <div className="w-full">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      ) : null}
      <label className="min-w-0 flex-1 text-xs text-ink-muted">
        <span className="block">{t('wh.cancelReason')}</span>
        <Input name="reason" maxLength={500} className="mt-0.5" aria-label={t('wh.cancelReason')} />
      </label>
      <Submit label={t('wh.cancel')} variant="danger" testId="cancel-task-button" />
    </form>
  );
}

export function RecordPickupForm({
  taskId,
  salesOrderId,
}: {
  taskId: string;
  salesOrderId: string;
}) {
  const [state, formAction] = useActionState<WarehouseFormState, FormData>(
    recordPickupAction.bind(null, taskId, salesOrderId),
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('wh.pickupNote')}</span>
          <Input name="note" maxLength={500} className="mt-0.5" aria-label={t('wh.pickupNote')} />
        </label>
        <Submit label={t('wh.recordPickup')} variant="primary" testId="record-pickup-button" />
      </div>
      <p className="text-xs text-ink-faint">{t('wh.pickupHint')}</p>
    </form>
  );
}
