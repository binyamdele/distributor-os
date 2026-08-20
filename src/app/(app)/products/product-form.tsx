'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Button, ErrorNote, Field, Input, Select, Textarea } from '@/components/ui';
import { t } from '@/platform/i18n';
import { type ProductFormState, createProductAction } from './actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {label}
    </Button>
  );
}

const UNITS = ['bag', 'piece', 'm3', 'quintal', 'ton', 'roll', 'sheet'];

export function ProductForm({ currency }: { currency: string }) {
  const [state, formAction] = useActionState<ProductFormState, FormData>(createProductAction, {});

  return (
    <form action={formAction} className="space-y-5">
      {/* Field-specific errors render beside their field; only the rest reach the banner. */}
      {state.error && !state.field ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t('product.sku')} error={state.field === 'sku' ? state.error : undefined}>
          <Input name="sku" required maxLength={60} placeholder="RB-12" />
        </Field>

        <Field label={t('product.name')}>
          <Input name="name" required maxLength={200} placeholder="Rebar 12mm" />
        </Field>

        <Field label={t('product.category')}>
          <Input name="category" maxLength={100} placeholder="Reinforcement" />
        </Field>

        <Field label={t('product.unit')}>
          <Select name="unit" defaultValue="piece">
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={`${t('product.price')} (${currency})`}
          error={state.field === 'sellingPrice' ? state.error : undefined}
        >
          <Input
            name="sellingPrice"
            required
            inputMode="decimal"
            placeholder="1420.00"
            className="tabular"
          />
        </Field>

        <Field label={`${t('product.taxRate')} (%)`}>
          <Input
            name="taxRatePercent"
            type="number"
            step="0.01"
            min={0}
            max={100}
            defaultValue={15}
            className="tabular"
          />
        </Field>

        <Field label={t('product.available')}>
          <Input name="availableStock" type="number" min={0} defaultValue={0} className="tabular" />
        </Field>

        <Field label={t('product.reorderThreshold')}>
          <Input
            name="reorderThreshold"
            type="number"
            min={0}
            defaultValue={0}
            className="tabular"
          />
        </Field>
      </div>

      <Field label={t('product.aliases')} hint={t('product.aliasesHint')}>
        <Textarea name="aliases" rows={5} placeholder={'12mm\n12 mm steel\n12 fer\nrebar 12'} />
      </Field>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" name="active" defaultChecked className="size-4" />
        Active
      </label>

      <div className="flex items-center gap-3">
        <Submit label={t('action.create')} />
        <Link href="/products" className="text-sm text-ink-muted hover:text-ink">
          {t('action.cancel')}
        </Link>
      </div>
    </form>
  );
}

export function StockAdjustForm({
  action,
  unit,
}: {
  action: (state: ProductFormState, formData: FormData) => Promise<ProductFormState>;
  unit: string;
}) {
  const [state, formAction] = useActionState<ProductFormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      {state.ok ? <p className="text-sm text-positive">Stock updated.</p> : null}

      <div className="grid gap-4 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
        <Field label={`${t('product.adjustment')} (${unit})`}>
          <Input name="delta" type="number" required placeholder="-50" className="tabular" />
        </Field>

        <Field label={t('product.adjustmentReason')}>
          <Input name="reason" required maxLength={200} placeholder="Delivery received" />
        </Field>

        <Submit label={t('action.save')} />
      </div>
      <p className="text-xs text-ink-faint">
        Use a negative number to remove stock. Every change is recorded with your name and the
        reason.
      </p>
    </form>
  );
}
