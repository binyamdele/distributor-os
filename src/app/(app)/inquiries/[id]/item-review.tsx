'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Badge, Button, ErrorNote, Input, Select, cn } from '@/components/ui';
import { t } from '@/platform/i18n';
import { type InquiryFormState, reviewItemAction } from '../actions';

export interface ItemProps {
  id: string;
  position: number;
  rawName: string;
  requestedQuantity: number;
  requestedUnit: string | null;
  matchMethod: string;
  matchReason: string;
  ambiguous: boolean;
  proposedConfidence: number | null;
  band: 'strong' | 'review' | 'unresolved';
  reviewStatus: 'SUGGESTED' | 'CONFIRMED' | 'CORRECTED' | 'UNRESOLVED' | 'REJECTED';
  candidates: { productId: string; sku: string; name: string; confidence: number }[];
  product: {
    id: string;
    sku: string;
    name: string;
    unit: string;
    priceDisplay: string;
    freeStock: number;
  } | null;
  unitCompatibility: 'match' | 'assumed' | 'mismatch' | 'unknown' | null;
  unitReason: string | null;
  stockShortfall: number | null;
}

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  unit: string;
}

const REVIEW_TONE = {
  SUGGESTED: 'accent',
  CONFIRMED: 'positive',
  CORRECTED: 'positive',
  UNRESOLVED: 'caution',
  REJECTED: 'neutral',
} as const;

const REVIEW_LABEL = {
  SUGGESTED: 'review.suggested',
  CONFIRMED: 'review.confirmed',
  CORRECTED: 'review.corrected',
  UNRESOLVED: 'review.unresolved',
  REJECTED: 'review.rejected',
} as const;

function ActionButton({
  children,
  variant = 'secondary',
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} className="px-2.5 py-1.5 text-xs">
      {children}
    </Button>
  );
}

/**
 * One requested line.
 *
 * Laid out as a stacking card rather than a table row: the review screen carries eight facts
 * per line, and a salesperson checking a quotation on a phone in a yard needs them to reflow
 * rather than scroll sideways.
 *
 * The machine's proposal stays visible after a correction. "AI suggested Rebar 10mm, Meron
 * changed it to 12mm" is the record that tells you whether the parser is improving.
 */
export function ItemReview({
  item,
  inquiryId,
  products,
  editable,
}: {
  item: ItemProps;
  inquiryId: string;
  products: ProductOption[];
  editable: boolean;
}) {
  const [state, formAction] = useActionState<InquiryFormState, FormData>(
    reviewItemAction.bind(null, inquiryId),
    {},
  );
  const [changing, setChanging] = useState(false);

  const removed = item.reviewStatus === 'REJECTED';
  const confidencePercent =
    item.proposedConfidence === null ? null : Math.round(item.proposedConfidence * 100);

  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        removed ? 'border-border-subtle bg-surface-sunken opacity-60' : 'border-border-subtle bg-surface-raised',
        item.ambiguous && !item.product ? 'border-caution/40' : '',
      )}
      data-testid="inquiry-item"
      data-review-status={item.reviewStatus}
    >
      {state.error ? (
        <div className="mb-3">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs tracking-wide text-ink-muted uppercase">
            {t('item.requested')}
          </div>
          {/* The customer's own words, unmodified — the evidence everything else is checked against. */}
          <div className="mt-0.5 font-medium text-ink">
            <span className="tabular">{item.requestedQuantity.toLocaleString()}</span>{' '}
            {item.requestedUnit ?? ''} {item.rawName}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={REVIEW_TONE[item.reviewStatus]}>{t(REVIEW_LABEL[item.reviewStatus])}</Badge>
          {item.ambiguous ? <Badge tone="caution">{t('review.ambiguous')}</Badge> : null}
          {item.matchMethod === 'HUMAN' ? (
            <Badge>{t('inquiry.addedByHand')}</Badge>
          ) : confidencePercent !== null ? (
            <Badge
              tone={item.band === 'strong' ? 'positive' : item.band === 'review' ? 'caution' : 'neutral'}
            >
              {t('inquiry.aiSuggested')} · {confidencePercent}%
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-xs tracking-wide text-ink-muted uppercase">{t('item.proposed')}</div>
          {item.product ? (
            <>
              <div className="mt-0.5 text-ink">{item.product.name}</div>
              <div className="font-mono text-xs text-ink-faint">{item.product.sku}</div>
            </>
          ) : (
            <div className="mt-0.5 text-caution">{t('item.noMatch')}</div>
          )}
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{item.matchReason}</p>
          {item.unitCompatibility === 'mismatch' || item.unitCompatibility === 'unknown' ? (
            <p className="mt-1.5 text-xs text-critical">{item.unitReason}</p>
          ) : null}
        </div>

        {item.product ? (
          <div className="space-y-1 text-sm">
            <Row label={t('item.price')} value={item.product.priceDisplay} />
            <Row
              label={t('item.available')}
              value={`${item.product.freeStock.toLocaleString()} ${item.product.unit}`}
            />
            {item.stockShortfall !== null && item.stockShortfall < 0 ? (
              <div className="text-caution">
                {t('item.shortBy')} {Math.abs(item.stockShortfall).toLocaleString()}{' '}
                {item.product.unit}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Candidates, when the evidence did not separate them. Shown as choices rather than
          resolved silently — this is the case the brief calls out by name. */}
      {editable && !removed && item.candidates.length > 1 && item.reviewStatus === 'SUGGESTED' ? (
        <div className="mt-3 rounded-md bg-surface-sunken p-3">
          <div className="text-xs tracking-wide text-ink-muted uppercase">
            {t('item.otherCandidates')}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {item.candidates.slice(1).map((candidate) => (
              <form key={candidate.productId} action={formAction}>
                <input type="hidden" name="itemId" value={item.id} />
                <input type="hidden" name="intent" value="correct" />
                <input type="hidden" name="productId" value={candidate.productId} />
                <ActionButton variant="ghost">
                  {candidate.name} · {Math.round(candidate.confidence * 100)}%
                </ActionButton>
              </form>
            ))}
          </div>
        </div>
      ) : null}

      {editable && !removed ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          {item.product && item.reviewStatus === 'SUGGESTED' ? (
            <form action={formAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <input type="hidden" name="intent" value="confirm" />
              <ActionButton variant="primary">{t('item.confirm')}</ActionButton>
            </form>
          ) : null}

          <Button
            type="button"
            variant="secondary"
            className="px-2.5 py-1.5 text-xs"
            onClick={() => setChanging((open) => !open)}
          >
            {t('item.change')}
          </Button>

          <form action={formAction}>
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="intent" value="unresolved" />
            <ActionButton variant="ghost">{t('item.unresolved')}</ActionButton>
          </form>

          <form action={formAction}>
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="intent" value="reject" />
            <ActionButton variant="ghost">{t('item.remove')}</ActionButton>
          </form>

          <form action={formAction} className="ml-auto flex items-end gap-2">
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="intent" value="quantity" />
            <label className="text-xs text-ink-muted">
              <span className="block">{t('item.quantity')}</span>
              <Input
                name="quantity"
                type="number"
                min={1}
                defaultValue={item.requestedQuantity}
                className="tabular mt-0.5 w-24 px-2 py-1 text-sm"
                aria-label={`${t('item.quantity')} ${item.rawName}`}
              />
            </label>
            <ActionButton variant="ghost">{t('item.updateQuantity')}</ActionButton>
          </form>
        </div>
      ) : null}

      {changing && editable && !removed ? (
        <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="intent" value="correct" />
          <label className="min-w-0 flex-1 text-xs text-ink-muted">
            <span className="block">{t('item.chooseProduct')}</span>
            <Select
              name="productId"
              defaultValue={item.product?.id ?? ''}
              className="mt-0.5"
              aria-label={`${t('item.chooseProduct')} ${item.rawName}`}
            >
              <option value="">—</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({product.sku})
                </option>
              ))}
            </Select>
          </label>
          <ActionButton variant="primary">{t('action.save')}</ActionButton>
        </form>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-muted">{label}</span>
      <span className="tabular text-ink">{value}</span>
    </div>
  );
}

/** Adds a line the parser missed entirely. */
export function AddItemForm({
  inquiryId,
  products,
}: {
  inquiryId: string;
  products: ProductOption[];
}) {
  const [state, formAction] = useActionState<InquiryFormState, FormData>(
    reviewItemAction.bind(null, inquiryId),
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="intent" value="add" />
      {state.error ? (
        <div className="w-full">
          <ErrorNote>{state.error}</ErrorNote>
        </div>
      ) : null}

      <label className="min-w-0 flex-1 text-xs text-ink-muted">
        <span className="block">{t('item.chooseProduct')}</span>
        <Select name="productId" defaultValue="" className="mt-0.5" aria-label={t('inquiry.addItem')}>
          <option value="">—</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name} ({product.sku})
            </option>
          ))}
        </Select>
      </label>

      <label className="text-xs text-ink-muted">
        <span className="block">{t('item.quantity')}</span>
        <Input
          name="quantity"
          type="number"
          min={1}
          defaultValue={1}
          className="tabular mt-0.5 w-24"
          aria-label={`${t('inquiry.addItem')} ${t('item.quantity')}`}
        />
      </label>

      <ActionButton variant="secondary">{t('action.create')}</ActionButton>
    </form>
  );
}
