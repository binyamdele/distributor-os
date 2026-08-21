'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote, Input, Select } from '@/components/ui';
import { t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import {
  type DeliveryFormState,
  assignAction,
  completeAction,
  dispatchAction,
  failAction,
} from './actions';

const REASONS = [
  'CUSTOMER_UNAVAILABLE',
  'WRONG_ADDRESS',
  'VEHICLE_ISSUE',
  'CUSTOMER_REJECTED',
  'OTHER',
] as const;

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
 * Assignment: three plain fields.
 *
 * Not a driver account, not a vehicle record. A pilot distributor has three drivers and knows
 * their names; building a fleet database to hold that would be a system to maintain in exchange
 * for nothing the operation needs.
 */
export function AssignForm({
  deliveryId,
  defaults,
}: {
  deliveryId: string;
  defaults: { driverName: string; driverPhone: string; vehicleReference: string };
}) {
  const [state, formAction] = useActionState<DeliveryFormState, FormData>(
    assignAction.bind(null, deliveryId),
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-ink-muted">
          <span className="block">{t('del.driver')}</span>
          <Input
            name="driverName"
            defaultValue={defaults.driverName}
            required
            maxLength={120}
            className="mt-0.5"
            aria-label={t('del.driver')}
          />
        </label>
        <label className="text-xs text-ink-muted">
          <span className="block">{t('del.driverPhone')}</span>
          <Input
            name="driverPhone"
            defaultValue={defaults.driverPhone}
            maxLength={40}
            className="mt-0.5"
            aria-label={t('del.driverPhone')}
          />
        </label>
        <label className="text-xs text-ink-muted">
          <span className="block">{t('del.vehicle')}</span>
          <Input
            name="vehicleReference"
            defaultValue={defaults.vehicleReference}
            maxLength={60}
            className="mt-0.5"
            aria-label={t('del.vehicle')}
          />
        </label>
      </div>

      <Submit label={t('del.assign')} testId="assign-delivery-button" />
    </form>
  );
}

export function DispatchForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction] = useActionState<DeliveryFormState, FormData>(
    dispatchAction.bind(null, deliveryId),
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('del.dispatch')} variant="primary" testId="dispatch-button" />
    </form>
  );
}

export function CompleteDeliveryForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction] = useActionState<DeliveryFormState, FormData>(
    completeAction.bind(null, deliveryId),
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('del.deliveryNote')}</span>
          <Input name="note" maxLength={500} className="mt-0.5" aria-label={t('del.deliveryNote')} />
        </label>
        <Submit label={t('del.markDelivered')} variant="primary" testId="mark-delivered-button" />
      </div>
      {/* Said plainly, because the alternative is a claim the software cannot support. */}
      <p className="text-xs text-ink-faint">{t('del.notProof')}</p>
    </form>
  );
}

export function FailDeliveryForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction] = useActionState<DeliveryFormState, FormData>(
    failAction.bind(null, deliveryId),
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-muted">
          <span className="block">{t('del.failureReason')}</span>
          <Select
            name="reason"
            defaultValue="CUSTOMER_UNAVAILABLE"
            className="mt-0.5"
            aria-label={t('del.failureReason')}
          >
            {REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {t(`fail.${reason}` as MessageKey)}
              </option>
            ))}
          </Select>
        </label>
        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('del.failureNote')}</span>
          <Input name="note" maxLength={500} className="mt-0.5" aria-label={t('del.failureNote')} />
        </label>
        <Submit label={t('del.markFailed')} variant="danger" testId="mark-failed-button" />
      </div>
      <p className="text-xs text-ink-faint">{t('del.failedNoRestock')}</p>
    </form>
  );
}
