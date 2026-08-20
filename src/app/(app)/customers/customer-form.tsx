'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Button, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui';
import { t } from '@/platform/i18n';
import type { CustomerFormState } from './actions';

export interface CustomerFormValues {
  companyName?: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  preferredLanguage?: string;
  address?: string | null;
  creditStatus?: string;
  /** Decimal string, e.g. "2000000.00". Never a number — see platform/money. */
  creditLimit?: string;
  paymentTermsDays?: number;
  notes?: string | null;
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {label}
    </Button>
  );
}

export function CustomerForm({
  action,
  values = {},
  submitLabel,
  currency,
  saved,
}: {
  action: (state: CustomerFormState, formData: FormData) => Promise<CustomerFormState>;
  values?: CustomerFormValues;
  submitLabel: string;
  currency: string;
  saved?: boolean;
}) {
  const [state, formAction] = useActionState<CustomerFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-5">
      {/*
        The banner is for errors that belong to no single field. When the error names a field,
        it is shown beside that field instead — saying the same sentence twice makes the form
        look broken rather than helpful.
      */}
      {state.error && !state.field ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t('customer.companyName')} error={state.field === 'companyName' ? state.error : undefined}>
          <Input name="companyName" defaultValue={values.companyName ?? ''} required maxLength={200} />
        </Field>

        <Field label={t('customer.contactName')}>
          <Input name="contactName" defaultValue={values.contactName ?? ''} maxLength={200} />
        </Field>

        <Field label={t('customer.phone')}>
          <Input name="phone" defaultValue={values.phone ?? ''} maxLength={40} inputMode="tel" />
        </Field>

        <Field label={t('customer.email')}>
          <Input name="email" type="email" defaultValue={values.email ?? ''} maxLength={200} />
        </Field>

        <Field label={t('customer.address')}>
          <Input name="address" defaultValue={values.address ?? ''} maxLength={500} />
        </Field>

        <Field label={t('customer.preferredLanguage')}>
          <Select name="preferredLanguage" defaultValue={values.preferredLanguage ?? 'en'}>
            <option value="en">English</option>
            <option value="am">አማርኛ</option>
          </Select>
        </Field>

        <Field label={t('customer.creditStatus')}>
          <Select name="creditStatus" defaultValue={values.creditStatus ?? 'CASH_ONLY'}>
            <option value="CASH_ONLY">{t('credit.cashOnly')}</option>
            <option value="CREDIT_ALLOWED">{t('credit.creditAllowed')}</option>
            <option value="SUSPENDED">{t('credit.suspended')}</option>
          </Select>
        </Field>

        <Field
          label={`${t('customer.creditLimit')} (${currency})`}
          hint="Leave at 0 for cash-only customers."
          error={state.field === 'creditLimit' ? state.error : undefined}
        >
          <Input
            name="creditLimit"
            defaultValue={values.creditLimit ?? '0'}
            inputMode="decimal"
            className="tabular"
          />
        </Field>

        <Field label={`${t('customer.paymentTerms')} (days)`}>
          <Input
            name="paymentTermsDays"
            type="number"
            min={0}
            max={365}
            defaultValue={values.paymentTermsDays ?? 0}
            className="tabular"
          />
        </Field>
      </div>

      <Field label={t('customer.notes')}>
        <Textarea name="notes" rows={3} defaultValue={values.notes ?? ''} maxLength={2000} />
      </Field>

      <div className="flex items-center gap-3">
        <Submit label={submitLabel} />
        <Link href="/customers" className="text-sm text-ink-muted hover:text-ink">
          {t('action.cancel')}
        </Link>
        {saved && !state.error ? (
          <span className="text-sm text-positive">{t('customer.created')}</span>
        ) : null}
      </div>
    </form>
  );
}
