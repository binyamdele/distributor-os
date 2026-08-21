'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote, Input, Select } from '@/components/ui';
import { t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import {
  type PaymentFormState,
  confirmAction,
  correctAction,
  extractAction,
  rejectAction,
} from '../actions';

const METHODS = ['BANK_TRANSFER', 'TELEBIRR', 'MOBILE_MONEY', 'CASH_DEPOSIT', 'OTHER'] as const;

function Submit({
  label,
  variant = 'secondary',
  disabled,
  testId,
}: {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  testId?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending || disabled} data-testid={testId}>
      {label}
    </Button>
  );
}

export function ExtractForm({ paymentId }: { paymentId: string }) {
  const [state, formAction] = useActionState<PaymentFormState, FormData>(
    extractAction.bind(null, paymentId),
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <Submit label={t('pay.extract')} testId="extract-button" />
    </form>
  );
}

/**
 * Fixing what the extractor read, or filling in what it could not.
 *
 * Editing here always leaves the payment in NEEDS_REVIEW — correcting a figure is not a step
 * towards confirming it, and a screen that treated it as one would let a reviewer type the
 * expected amount in and press Confirm without ever looking at the file.
 */
export function CorrectForm({
  paymentId,
  defaults,
}: {
  paymentId: string;
  defaults: {
    amountClaimed: string;
    method: string;
    providerName: string;
    transactionReference: string;
    payerName: string;
    paymentDate: string;
  };
}) {
  const [state, formAction] = useActionState<PaymentFormState, FormData>(
    correctAction.bind(null, paymentId),
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.amountClaimed')}</span>
          <Input
            name="amountClaimed"
            defaultValue={defaults.amountClaimed}
            inputMode="decimal"
            required
            className="mt-0.5"
            aria-label={t('pay.amountClaimed')}
          />
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.method')}</span>
          <Select
            name="method"
            defaultValue={defaults.method}
            className="mt-0.5"
            aria-label={t('pay.method')}
          >
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {t(`method.${method}` as MessageKey)}
              </option>
            ))}
          </Select>
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.provider')}</span>
          <Input
            name="providerName"
            defaultValue={defaults.providerName}
            maxLength={120}
            className="mt-0.5"
            aria-label={t('pay.provider')}
          />
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.reference')}</span>
          <Input
            name="transactionReference"
            defaultValue={defaults.transactionReference}
            maxLength={120}
            className="mt-0.5"
            aria-label={t('pay.reference')}
          />
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.payer')}</span>
          <Input
            name="payerName"
            defaultValue={defaults.payerName}
            maxLength={200}
            className="mt-0.5"
            aria-label={t('pay.payer')}
          />
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.date')}</span>
          <Input
            name="paymentDate"
            type="date"
            defaultValue={defaults.paymentDate}
            className="mt-0.5"
            aria-label={t('pay.date')}
          />
        </label>
      </div>

      <Submit label={t('action.save')} testId="correct-button" />
    </form>
  );
}

/**
 * The confirmation.
 *
 * The payload hash travels in a hidden field, so the server can tell whether the figures on the
 * screen are still the figures in the database. If a correction landed in between, the module
 * refuses and the reviewer looks again — which is the whole point of binding an approval to
 * exact numbers rather than to an id.
 */
export function ConfirmForm({
  paymentId,
  payloadHash,
  blocked,
}: {
  paymentId: string;
  payloadHash: string;
  blocked: boolean;
}) {
  const [state, formAction] = useActionState<PaymentFormState, FormData>(
    confirmAction.bind(null, paymentId),
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <input type="hidden" name="payloadHash" value={payloadHash} />
      <Submit
        label={t('pay.confirmButton')}
        variant="primary"
        disabled={blocked}
        testId="confirm-button"
      />
    </form>
  );
}

export function RejectForm({ paymentId }: { paymentId: string }) {
  const [state, formAction] = useActionState<PaymentFormState, FormData>(
    rejectAction.bind(null, paymentId),
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
        <span className="block">{t('pay.rejectReason')}</span>
        <Input
          name="reason"
          maxLength={500}
          required
          className="mt-0.5"
          aria-label={t('pay.rejectReason')}
        />
      </label>

      <Submit label={t('pay.rejectButton')} variant="danger" testId="reject-button" />
    </form>
  );
}
