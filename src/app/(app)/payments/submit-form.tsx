'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote, Input, Select } from '@/components/ui';
import { t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { type PaymentFormState, submitPaymentAction } from './actions';

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

/**
 * Recording what a customer says they paid.
 *
 * Lives with sales, because sales is who the customer sends the screenshot to. The disclaimer
 * is doing real work: this form creates a claim and nothing more, and someone who believed
 * otherwise might tell a customer their goods are ready.
 */
export function SubmitPaymentForm({
  salesOrderId,
  outstanding,
}: {
  salesOrderId: string;
  /** The remaining balance, pre-filled — the amount claimed most often. Editable. */
  outstanding: string;
}) {
  const [state, formAction] = useActionState<PaymentFormState, FormData>(
    submitPaymentAction.bind(null, salesOrderId),
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
            defaultValue={outstanding}
            inputMode="decimal"
            required
            className="mt-0.5"
            aria-label={t('pay.amountClaimed')}
          />
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.method')}</span>
          <Select name="method" defaultValue="BANK_TRANSFER" className="mt-0.5" aria-label={t('pay.method')}>
            {METHODS.map((method) => (
              <option key={method} value={method}>
                {t(`method.${method}` as MessageKey)}
              </option>
            ))}
          </Select>
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.provider')}</span>
          <Input name="providerName" maxLength={120} className="mt-0.5" aria-label={t('pay.provider')} />
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.reference')}</span>
          <Input
            name="transactionReference"
            maxLength={120}
            className="mt-0.5"
            aria-label={t('pay.reference')}
          />
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.payer')}</span>
          <Input name="payerName" maxLength={200} className="mt-0.5" aria-label={t('pay.payer')} />
        </label>

        <label className="text-xs text-ink-muted">
          <span className="block">{t('pay.date')}</span>
          <Input name="paymentDate" type="date" className="mt-0.5" aria-label={t('pay.date')} />
        </label>
      </div>

      <label className="block text-xs text-ink-muted">
        <span className="block">{t('pay.evidence')}</span>
        <input
          type="file"
          name="evidence"
          accept="image/jpeg,image/png,application/pdf"
          className="mt-1 block w-full text-sm text-ink file:mr-3 file:rounded-md file:border file:border-border-subtle file:bg-surface-sunken file:px-3 file:py-1.5 file:text-sm file:text-ink"
          aria-label={t('pay.evidence')}
        />
        <span className="mt-1 block text-ink-faint">{t('pay.evidenceHint')}</span>
      </label>

      <Submit label={t('pay.submit')} variant="primary" testId="submit-payment-button" />

      <p className="text-xs text-ink-faint">{t('pay.submitDisclaimer')}</p>
    </form>
  );
}
