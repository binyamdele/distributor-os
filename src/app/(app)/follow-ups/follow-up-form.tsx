'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote, Input, Select } from '@/components/ui';
import { t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { type FollowUpFormState, completeFollowUpAction, snoozeFollowUpAction } from './actions';

const OUTCOMES = [
  'NO_RESPONSE',
  'CUSTOMER_CONSIDERING',
  'CUSTOMER_REQUESTED_CHANGE',
  'CUSTOMER_ACCEPTED',
  'CUSTOMER_REJECTED',
  'OTHER',
] as const;

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="px-2.5 py-1.5 text-xs">
      {label}
    </Button>
  );
}

/**
 * Recording what happened when a salesperson chased a quotation.
 *
 * "Schedule another" is a checkbox rather than an automatic consequence. A queue that refills
 * itself teaches people to ignore it, and the organization's cap stops the sequence regardless.
 */
export function CompleteFollowUpForm({ followUpId }: { followUpId: string }) {
  const [state, formAction] = useActionState<FollowUpFormState, FormData>(
    completeFollowUpAction.bind(null, followUpId),
    {},
  );

  return (
    <div className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      {state.capReached ? (
        <p className="text-xs text-caution">{t('followUp.capReached')}</p>
      ) : null}

      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-muted">
          <span className="block">{t('followUp.outcome')}</span>
          <Select
            name="outcome"
            defaultValue="NO_RESPONSE"
            className="mt-0.5"
            aria-label={t('followUp.outcome')}
          >
            {OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {t(`outcome.${outcome}` as MessageKey)}
              </option>
            ))}
          </Select>
        </label>

        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('followUp.note')}</span>
          <Input name="note" maxLength={1000} className="mt-0.5" aria-label={t('followUp.note')} />
        </label>

        <label className="flex items-center gap-1.5 pb-2 text-xs text-ink">
          <input type="checkbox" name="scheduleNext" className="size-4" />
          {t('followUp.scheduleNext')}
        </label>

        <Submit label={t('followUp.complete')} />
      </form>
    </div>
  );
}

export function SnoozeForm({ followUpId }: { followUpId: string }) {
  const [state, formAction] = useActionState<FollowUpFormState, FormData>(
    snoozeFollowUpAction.bind(null, followUpId),
    {},
  );

  return (
    <form action={formAction} className="flex items-end gap-1.5">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <label className="text-xs text-ink-muted">
        <span className="block">Snooze days</span>
        <Input
          name="days"
          type="number"
          min={1}
          max={30}
          defaultValue={2}
          className="tabular mt-0.5 w-20 px-2 py-1 text-sm"
          aria-label="Snooze days"
        />
      </label>
      <Submit label="Snooze" />
    </form>
  );
}
