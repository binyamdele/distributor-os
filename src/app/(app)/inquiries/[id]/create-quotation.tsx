'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote, Field, Select } from '@/components/ui';
import { t } from '@/platform/i18n';
import { type QuotationFormState, createQuotationAction } from '../../quotations/actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {t('quote.new')}
    </Button>
  );
}

/**
 * Drafts a quotation from a reviewed inquiry.
 *
 * Credit terms are offered only when the customer is actually eligible. The rules engine would
 * refuse them at approval anyway; presenting the option would just be an invitation to be
 * refused three screens later.
 */
export function CreateQuotationForm({
  inquiryId,
  creditAllowed,
}: {
  inquiryId: string;
  creditAllowed: boolean;
}) {
  const [state, formAction] = useActionState<QuotationFormState, FormData>(
    createQuotationAction.bind(null, inquiryId),
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-52">
          <Field label={t('quote.paymentTerms')}>
            <Select
              name="terms"
              defaultValue="CASH"
              onChange={(event) => {
                const form = event.currentTarget.form;
                if (!form) return;
                const [type, days] = event.currentTarget.value.split('_');
                (form.elements.namedItem('paymentType') as HTMLInputElement).value = type ?? 'CASH';
                (form.elements.namedItem('paymentTermsDays') as HTMLInputElement).value =
                  days ?? '0';
              }}
            >
              <option value="CASH">{t('quote.cash')}</option>
              {creditAllowed ? (
                <>
                  <option value="CREDIT_7">{t('quote.credit7')}</option>
                  <option value="CREDIT_15">{t('quote.credit15')}</option>
                  <option value="CREDIT_30">{t('quote.credit30')}</option>
                </>
              ) : null}
            </Select>
          </Field>
        </div>
        <input type="hidden" name="paymentType" defaultValue="CASH" />
        <input type="hidden" name="paymentTermsDays" defaultValue="0" />
        <Submit />
      </div>

      {!creditAllowed ? (
        <p className="text-xs text-ink-faint">
          This customer cannot be offered credit terms. A cash quotation is still fine.
        </p>
      ) : null}
    </form>
  );
}
