'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, Card, ErrorNote, Input, Select } from '@/components/ui';
import { t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import {
  type OrderFormState,
  cancelOrderAction,
  createOrderAction,
  recordAcceptanceAction,
  recordRejectionAction,
} from './actions';

const SOURCES = ['PHONE', 'MESSAGE', 'EMAIL', 'IN_PERSON', 'OTHER'] as const;
const REASONS = [
  'PRICE',
  'STOCK',
  'DELIVERY',
  'TIMING',
  'COMPETITOR',
  'CUSTOMER_CANCELLED',
  'OTHER',
] as const;

function Submit({
  label,
  variant = 'secondary',
}: {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {label}
    </Button>
  );
}

/**
 * Recording that the customer accepted.
 *
 * The disclaimer is not decoration. This is staff reporting a conversation, and presenting it as
 * anything more — a signature, a confirmation, an agreement captured by the system — would be an
 * overclaim that matters precisely when someone later disputes the order.
 */
export function RecordAcceptanceForm({ quotationId }: { quotationId: string }) {
  const [state, formAction] = useActionState<OrderFormState, FormData>(
    recordAcceptanceAction.bind(null, quotationId),
    {},
  );

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-muted">
          <span className="block">{t('accept.source')}</span>
          <Select name="source" defaultValue="PHONE" className="mt-0.5" aria-label={t('accept.source')}>
            {SOURCES.map((source) => (
              <option key={source} value={source}>
                {t(`source.${source}` as MessageKey)}
              </option>
            ))}
          </Select>
        </label>

        <label className="min-w-0 flex-1 text-xs text-ink-muted">
          <span className="block">{t('accept.note')}</span>
          <Input name="note" maxLength={1000} className="mt-0.5" aria-label={t('accept.note')} />
        </label>

        <Submit label={t('accept.button')} variant="primary" />
      </div>

      <p className="text-xs text-ink-faint">{t('accept.disclaimer')}</p>
    </form>
  );
}

export function RecordRejectionForm({ quotationId }: { quotationId: string }) {
  const [state, formAction] = useActionState<OrderFormState, FormData>(
    recordRejectionAction.bind(null, quotationId),
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      {state.error ? (
        <div className="w-full">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      ) : null}

      <label className="text-xs text-ink-muted">
        <span className="block">{t('reject.reason')}</span>
        {/* Optional on purpose: forcing a category produces a category, not a reason. */}
        <Select name="reason" defaultValue="" className="mt-0.5" aria-label={t('reject.reason')}>
          <option value="">—</option>
          {REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {t(`reason.${reason}` as MessageKey)}
            </option>
          ))}
        </Select>
      </label>

      <label className="min-w-0 flex-1 text-xs text-ink-muted">
        <span className="block">{t('accept.note')}</span>
        <Input name="note" maxLength={1000} className="mt-0.5" aria-label={t('reject.reason')} />
      </label>

      <Submit label={t('reject.button')} />
    </form>
  );
}

/**
 * Converting an accepted quotation into an order.
 *
 * The interesting path is the failure one. Stock can disappear between a quotation being sent
 * and the customer answering, so this refuses with exact numbers per product rather than a
 * generic error — the salesperson needs those numbers to have the next conversation.
 */
export function CreateOrderForm({ quotationId }: { quotationId: string }) {
  const [state, formAction] = useActionState<OrderFormState, FormData>(
    createOrderAction.bind(null, quotationId),
    {},
  );

  return (
    <div className="space-y-3">
      {state.shortfalls && state.shortfalls.length > 0 ? (
        <Card className="border-critical/30 bg-critical-soft" data-testid="stock-shortfall">
          <h3 className="text-sm font-semibold text-critical">{t('stock.cannotCreate')}</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {state.shortfalls.map((shortfall) => (
              <li key={shortfall.productId}>
                <div className="font-medium text-ink">{shortfall.description}</div>
                <div className="tabular mt-0.5 text-ink-muted">
                  {t('stock.requested')}: {shortfall.requested.toLocaleString()} {shortfall.unit}
                  {' · '}
                  {t('stock.availableToReserve')}: {shortfall.availableToReserve.toLocaleString()}{' '}
                  {shortfall.unit}
                  {' · '}
                  <span className="text-critical">
                    {t('stock.shortfall')} {shortfall.shortfall.toLocaleString()} {shortfall.unit}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-muted">{t('stock.explain')}</p>
        </Card>
      ) : state.error ? (
        <ErrorNote>{state.error}</ErrorNote>
      ) : null}

      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="deliveryRequired" className="size-4" />
          {t('order.deliveryRequired')}
        </label>
        <Submit label={t('order.create')} variant="primary" />
      </form>
    </div>
  );
}

export function CancelOrderForm({ orderId }: { orderId: string }) {
  const [state, formAction] = useActionState<OrderFormState, FormData>(
    cancelOrderAction.bind(null, orderId),
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
        <span className="block">{t('order.cancelReason')}</span>
        <Input name="reason" maxLength={500} className="mt-0.5" aria-label={t('order.cancelReason')} />
      </label>

      <Submit label={t('order.cancel')} variant="danger" />
    </form>
  );
}
