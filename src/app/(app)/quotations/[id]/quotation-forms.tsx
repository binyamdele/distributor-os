'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote, Input, Select } from '@/components/ui';
import { t } from '@/platform/i18n';
import {
  type QuotationFormState,
  approveQuotationAction,
  editQuotationAction,
  markSentAction,
  rejectQuotationAction,
  submitQuotationAction,
} from '../actions';

function Submit({
  label,
  variant = 'secondary',
  disabled,
  size = 'sm',
}: {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending || disabled}
      className={size === 'sm' ? 'px-2.5 py-1.5 text-xs' : undefined}
    >
      {label}
    </Button>
  );
}

/** Quantity and discount, edited in place on a line. */
export function LineEditForm({
  quotationId,
  lineId,
  quantity,
  discountPercent,
  description,
}: {
  quotationId: string;
  lineId: string;
  quantity: number;
  discountPercent: string;
  description: string;
}) {
  const [state, formAction] = useActionState<QuotationFormState, FormData>(
    editQuotationAction.bind(null, quotationId),
    {},
  );

  return (
    <div className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="flex flex-wrap items-end gap-2">
        <form action={formAction} className="flex items-end gap-1.5">
          <input type="hidden" name="intent" value="quantity" />
          <input type="hidden" name="lineId" value={lineId} />
          <label className="text-xs text-ink-muted">
            <span className="block">{t('quote.quantity')}</span>
            <Input
              name="quantity"
              type="number"
              min={1}
              defaultValue={quantity}
              className="tabular mt-0.5 w-24 px-2 py-1 text-sm"
              aria-label={`${t('quote.quantity')} ${description}`}
            />
          </label>
          <Submit label={t('action.save')} />
        </form>

        <form action={formAction} className="flex items-end gap-1.5">
          <input type="hidden" name="intent" value="discount" />
          <input type="hidden" name="lineId" value={lineId} />
          <label className="text-xs text-ink-muted">
            <span className="block">{t('quote.discount')} %</span>
            <Input
              name="discountPercent"
              inputMode="decimal"
              defaultValue={discountPercent}
              className="tabular mt-0.5 w-24 px-2 py-1 text-sm"
              aria-label={`${t('quote.discount')} ${description}`}
            />
          </label>
          <Submit label={t('action.save')} />
        </form>

        <form action={formAction}>
          <input type="hidden" name="intent" value="removeLine" />
          <input type="hidden" name="lineId" value={lineId} />
          <Submit label={t('quote.removeLine')} variant="ghost" />
        </form>
      </div>
    </div>
  );
}

export function AddLineForm({
  quotationId,
  products,
}: {
  quotationId: string;
  products: { id: string; sku: string; name: string }[];
}) {
  const [state, formAction] = useActionState<QuotationFormState, FormData>(
    editQuotationAction.bind(null, quotationId),
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="intent" value="addLine" />
      {state.error ? (
        <div className="w-full">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      ) : null}

      <label className="min-w-0 flex-1 text-xs text-ink-muted">
        <span className="block">{t('quote.addLine')}</span>
        <Select name="productId" defaultValue="" className="mt-0.5" aria-label={t('quote.addLine')}>
          <option value="">—</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name} ({product.sku})
            </option>
          ))}
        </Select>
      </label>

      <label className="text-xs text-ink-muted">
        <span className="block">{t('quote.quantity')}</span>
        <Input
          name="quantity"
          type="number"
          min={1}
          defaultValue={1}
          className="tabular mt-0.5 w-24"
          aria-label={`${t('quote.addLine')} ${t('quote.quantity')}`}
        />
      </label>

      <Submit label={t('action.create')} size="md" />
    </form>
  );
}

export function DeliveryAndTermsForm({
  quotationId,
  deliveryFee,
  paymentType,
  paymentTermsDays,
  creditAllowed,
  currency,
}: {
  quotationId: string;
  deliveryFee: string;
  paymentType: string;
  paymentTermsDays: number;
  creditAllowed: boolean;
  currency: string;
}) {
  const [state, formAction] = useActionState<QuotationFormState, FormData>(
    editQuotationAction.bind(null, quotationId),
    {},
  );

  const current = paymentType === 'CREDIT' ? `CREDIT_${paymentTermsDays}` : 'CASH';

  return (
    <div className="space-y-3">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="deliveryFee" />
        <label className="text-xs text-ink-muted">
          <span className="block">
            {t('quote.deliveryFee')} ({currency})
          </span>
          <Input
            name="deliveryFee"
            inputMode="decimal"
            defaultValue={deliveryFee}
            className="tabular mt-0.5 w-32"
            aria-label={t('quote.deliveryFee')}
          />
        </label>
        <Submit label={t('action.save')} />
      </form>

      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="paymentTerms" />
        <label className="text-xs text-ink-muted">
          <span className="block">{t('quote.paymentTerms')}</span>
          <Select
            name="terms"
            defaultValue={current}
            className="mt-0.5"
            aria-label={t('quote.paymentTerms')}
            onChange={(event) => {
              const form = event.currentTarget.form;
              if (!form) return;
              const [type, days] = event.currentTarget.value.split('_');
              (form.elements.namedItem('paymentType') as HTMLInputElement).value = type ?? 'CASH';
              (form.elements.namedItem('paymentTermsDays') as HTMLInputElement).value = days ?? '0';
            }}
          >
            <option value="CASH">{t('quote.cash')}</option>
            {/* Credit options are withheld entirely when the customer is not eligible. The rules
                engine would refuse them anyway; offering them would just invite the refusal. */}
            {creditAllowed ? (
              <>
                <option value="CREDIT_7">{t('quote.credit7')}</option>
                <option value="CREDIT_15">{t('quote.credit15')}</option>
                <option value="CREDIT_30">{t('quote.credit30')}</option>
              </>
            ) : null}
          </Select>
        </label>
        <input type="hidden" name="paymentType" defaultValue={paymentType} />
        <input type="hidden" name="paymentTermsDays" defaultValue={paymentTermsDays} />
        <Submit label={t('action.save')} />
      </form>
    </div>
  );
}

export function SubmitForApprovalForm({ quotationId }: { quotationId: string }) {
  const [state, formAction] = useActionState<QuotationFormState, FormData>(
    submitQuotationAction.bind(null, quotationId),
    {},
  );

  return (
    <div className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <form action={formAction}>
        <Submit label={t('quote.actionSubmit')} variant="primary" size="md" />
      </form>
    </div>
  );
}

export function ApprovalForm({
  quotationId,
  payloadHash,
  canApprove,
  blockedReason,
}: {
  quotationId: string;
  payloadHash: string;
  canApprove: boolean;
  blockedReason: string | null;
}) {
  const [approveState, approveAction] = useActionState<QuotationFormState, FormData>(
    approveQuotationAction.bind(null, quotationId),
    {},
  );
  const [rejectState, rejectAction] = useActionState<QuotationFormState, FormData>(
    rejectQuotationAction.bind(null, quotationId),
    {},
  );

  return (
    <div className="space-y-3">
      {approveState.error ? <ErrorNote>{approveState.error}</ErrorNote> : null}
      {rejectState.error ? <ErrorNote>{rejectState.error}</ErrorNote> : null}

      <div className="flex flex-wrap items-end gap-3">
        <form action={approveAction}>
          {/* The exact figures this approver was shown travel with the decision. */}
          <input type="hidden" name="expectedPayloadHash" value={payloadHash} />
          <Submit
            label={t('quote.actionApprove')}
            variant="primary"
            size="md"
            disabled={!canApprove}
          />
        </form>

        <form action={rejectAction} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-muted">
            <span className="block">{t('quote.reasonForRejection')}</span>
            <Input
              name="reason"
              className="mt-0.5 w-64"
              aria-label={t('quote.reasonForRejection')}
            />
          </label>
          <Submit label={t('quote.actionReject')} size="md" />
        </form>
      </div>

      {!canApprove ? (
        <p className="text-sm text-ink-muted">{blockedReason ?? t('quote.notYours')}</p>
      ) : null}
    </div>
  );
}

export function MarkSentForm({
  quotationId,
  disabled,
  disabledReason,
}: {
  quotationId: string;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const [state, formAction] = useActionState<QuotationFormState, FormData>(
    markSentAction.bind(null, quotationId),
    {},
  );

  return (
    <div className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <form action={formAction}>
        <Submit label={t('quote.actionMarkSent')} variant="primary" size="md" disabled={disabled} />
      </form>
      {disabled && disabledReason ? (
        <p className="text-sm text-ink-muted">{disabledReason}</p>
      ) : (
        <p className="text-xs text-ink-faint">{t('quote.sentNote')}</p>
      )}
    </div>
  );
}
