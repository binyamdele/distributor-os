'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote, Input } from '@/components/ui';
import { t } from '@/platform/i18n';
import {
  type ExceptionFormState,
  completeReturnAction,
  inspectAction,
  lossAction,
  receiveAction,
  reconcileAction,
  reduceReservationAction,
  reportAction,
  retryAction,
  returnAction,
  reviewAction,
  withdrawDiscrepancyAction,
  withdrawReturnAction,
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

/**
 * Reporting a count.
 *
 * One number and a note. There is deliberately no "and correct stock" checkbox: recording what
 * you counted and rewriting inventory are different acts held by different people, and a
 * checkbox would quietly collapse them.
 */
export function ReportCountForm({
  productId,
  warehouseTaskId,
  redirectTo,
}: {
  productId: string;
  warehouseTaskId?: string | null;
  redirectTo?: string | null;
}) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    reportAction.bind(null, productId, warehouseTaskId ?? null, redirectTo ?? null),
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-muted">
          <span className="block">{t('exc.physicalCount')}</span>
          <Input
            name="physicalCount"
            type="number"
            min={0}
            required
            className="mt-0.5 w-32"
            aria-label={t('exc.physicalCount')}
          />
        </label>
        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('exc.reportNote')}</span>
          <Input name="note" maxLength={1000} className="mt-0.5" aria-label={t('exc.reportNote')} />
        </label>
        <Submit label={t('exc.report')} variant="primary" testId="report-count-button" />
      </div>
      <p className="text-xs text-ink-faint">{t('exc.reportHint')}</p>
    </form>
  );
}

export function ReviewForm({ discrepancyId }: { discrepancyId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    reviewAction.bind(null, discrepancyId),
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('exc.review')} testId="review-button" />
    </form>
  );
}

export function ReconcileForm({ discrepancyId }: { discrepancyId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    reconcileAction.bind(null, discrepancyId),
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      {state.error ? (
        <ErrorNote data-testid="reconcile-error">{state.error}</ErrorNote>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('exc.reportNote')}</span>
          <Input name="note" maxLength={1000} className="mt-0.5" aria-label={t('exc.reportNote')} />
        </label>
        <Submit label={t('exc.reconcile')} variant="primary" testId="reconcile-button" />
      </div>
      <p className="text-xs text-ink-faint">{t('exc.reconcileHint')}</p>
    </form>
  );
}

export function WithdrawDiscrepancyForm({ discrepancyId }: { discrepancyId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    withdrawDiscrepancyAction.bind(null, discrepancyId),
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
        <span className="block">{t('exc.withdrawReason')}</span>
        <Input name="reason" maxLength={500} className="mt-0.5" aria-label={t('exc.withdrawReason')} />
      </label>
      <Submit label={t('exc.withdraw')} variant="danger" testId="withdraw-discrepancy-button" />
    </form>
  );
}

/**
 * Reducing one order's reservation.
 *
 * Rendered once per affected order, with no ordering, no highlight and no suggestion. The person
 * choosing sees who, how much and since when, and chooses.
 */
export function ReduceReservationForm({
  discrepancyId,
  reservationId,
  currentQuantity,
}: {
  discrepancyId: string;
  reservationId: string;
  currentQuantity: number;
}) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    reduceReservationAction.bind(null, discrepancyId, reservationId),
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-muted">
          <span className="block">{t('exc.reduceTo')}</span>
          <Input
            name="newQuantity"
            type="number"
            min={0}
            max={currentQuantity - 1}
            required
            className="mt-0.5 w-28"
            aria-label={t('exc.reduceTo')}
          />
        </label>
        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('exc.reduceReason')}</span>
          <Input
            name="reason"
            maxLength={500}
            required
            className="mt-0.5"
            aria-label={t('exc.reduceReason')}
          />
        </label>
        <Submit label={t('exc.reduce')} variant="danger" testId="reduce-reservation-button" />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Failed-delivery resolution
// ---------------------------------------------------------------------------

export function RetryForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    retryAction.bind(null, deliveryId),
    {},
  );

  return (
    <form action={formAction} className="space-y-1">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('fail.retry')} variant="primary" testId="retry-delivery-button" />
      <p className="text-xs text-ink-faint">{t('fail.retryHint')}</p>
    </form>
  );
}

export function ReturnForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    returnAction.bind(null, deliveryId),
    {},
  );

  return (
    <form action={formAction} className="space-y-1">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('exc.reportNote')}</span>
          <Input name="note" maxLength={1000} className="mt-0.5" aria-label={t('exc.reportNote')} />
        </label>
        <Submit label={t('fail.return')} testId="record-return-button" />
      </div>
      <p className="text-xs text-ink-faint">{t('fail.returnHint')}</p>
    </form>
  );
}

export function LossForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    lossAction.bind(null, deliveryId),
    {},
  );

  return (
    <form action={formAction} className="space-y-1">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('fail.lostNote')}</span>
          <Input
            name="note"
            maxLength={1000}
            required
            className="mt-0.5"
            aria-label={t('fail.lostNote')}
          />
        </label>
        <Submit label={t('fail.lost')} variant="danger" testId="mark-lost-button" />
      </div>
      {/* Both consequences said out loud, because both are what somebody will look for. */}
      <p className="text-xs text-ink-faint">{t('fail.lostHint')}</p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export function ReceiveReturnForm({ returnId }: { returnId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    receiveAction.bind(null, returnId),
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('ret.receive')} variant="primary" testId="receive-return-button" />
    </form>
  );
}

export interface InspectionLine {
  readonly id: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly quantityDispatched: number;
  readonly quantityExpected: number;
  readonly quantityReceived: number;
  readonly quantityRestockable: number;
  readonly quantityDamaged: number;
}

/**
 * The inspection.
 *
 * Received, sellable and damaged are entered; what is missing is derived. Letting somebody type
 * the fourth number independently would allow the invariant to be satisfied by adjusting the
 * wrong one, and the whole point is that nothing disappears.
 */
export function InspectReturnForm({
  returnId,
  lines,
}: {
  returnId: string;
  lines: readonly InspectionLine[];
}) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    inspectAction.bind(
      null,
      returnId,
      lines.map((line) => line.id),
    ),
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <ErrorNote data-testid="inspect-error">{state.error}</ErrorNote> : null}

      <div className="space-y-3">
        {lines.map((line) => (
          <div key={line.id} className="rounded-md border border-border-subtle p-3" data-testid="inspect-line" data-sku={line.sku}>
            <div className="mb-2">
              <span className="font-medium text-ink">{line.description}</span>{' '}
              <span className="font-mono text-xs text-ink-faint">{line.sku}</span>
              <div className="tabular text-xs text-ink-muted">
                {t('ret.dispatched')}: {line.quantityDispatched.toLocaleString()} {line.unit} ·{' '}
                {t('ret.expected')}: {line.quantityExpected.toLocaleString()}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-xs text-ink-muted">
                <span className="block">{t('ret.received')}</span>
                <Input
                  name={`received-${line.id}`}
                  type="number"
                  min={0}
                  max={line.quantityExpected}
                  defaultValue={line.quantityReceived}
                  className="mt-0.5"
                  aria-label={`${t('ret.received')} ${line.sku}`}
                />
              </label>
              <label className="text-xs text-ink-muted">
                <span className="block">{t('ret.restockable')}</span>
                <Input
                  name={`restockable-${line.id}`}
                  type="number"
                  min={0}
                  max={line.quantityExpected}
                  defaultValue={line.quantityRestockable}
                  className="mt-0.5"
                  aria-label={`${t('ret.restockable')} ${line.sku}`}
                />
              </label>
              <label className="text-xs text-ink-muted">
                <span className="block">{t('ret.damaged')}</span>
                <Input
                  name={`damaged-${line.id}`}
                  type="number"
                  min={0}
                  max={line.quantityExpected}
                  defaultValue={line.quantityDamaged}
                  className="mt-0.5"
                  aria-label={`${t('ret.damaged')} ${line.sku}`}
                />
              </label>
            </div>
          </div>
        ))}
      </div>

      <Submit label={t('ret.inspect')} variant="primary" testId="inspect-return-button" />
    </form>
  );
}

export function CompleteReturnForm({ returnId }: { returnId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    completeReturnAction.bind(null, returnId),
    {},
  );

  return (
    <form action={formAction} className="space-y-1">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('ret.complete')} variant="primary" testId="complete-return-button" />
      <p className="text-xs text-ink-faint">{t('ret.completeHint')}</p>
    </form>
  );
}

export function WithdrawReturnForm({ returnId }: { returnId: string }) {
  const [state, formAction] = useActionState<ExceptionFormState, FormData>(
    withdrawReturnAction.bind(null, returnId),
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
        <span className="block">{t('ret.withdrawReason')}</span>
        <Input name="reason" maxLength={500} className="mt-0.5" aria-label={t('ret.withdrawReason')} />
      </label>
      <Submit label={t('ret.withdraw')} variant="danger" testId="withdraw-return-button" />
    </form>
  );
}
