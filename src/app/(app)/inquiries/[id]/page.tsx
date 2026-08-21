import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { getInquiry } from '@/modules/inquiries';
import { listProducts } from '@/modules/catalog';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { formatMoney } from '@/platform/money';
import { formatDateTime, t } from '@/platform/i18n';
import { Badge, Card, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { STATUS_TONE, statusKey } from '../page';
import { AddItemForm, ItemReview } from './item-review';
import { MarkReadyButton, ParseButton } from './parse-controls';
import { CreateQuotationForm } from './create-quotation';

/**
 * The review screen.
 *
 * Operational, not conversational: no chat bubbles, no typing indicator, no assistant persona.
 * The salesperson is checking a machine's reading of a customer's message against a catalogue,
 * which is a table-and-queue task, and the interface says so. The AI's contribution is labelled
 * "AI suggested" with a number next to it, never "AI decided".
 */
export default async function InquiryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('read:inquiry');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const inquiry = await getInquiry(tx, id);
    if (!inquiry.ok) return null;
    return {
      inquiry: inquiry.value,
      products: await listProducts(tx),
      history: can(session.role, 'read:audit') ? await auditTrailFor(tx, 'inquiry', id) : [],
    };
  });

  if (!data) notFound();
  const { inquiry, products, history } = data;

  const canReview = can(session.role, 'review:inquiry-match');
  const canParse = can(session.role, 'parse:inquiry');
  const editable = canReview && (inquiry.status === 'NEEDS_REVIEW' || inquiry.status === 'READY_FOR_QUOTE');

  const creditAllowed = inquiry.customer?.creditStatus === 'CREDIT_ALLOWED';

  const productOptions = products.map((product) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
  }));

  return (
    <>
      <PageHeader
        title={inquiry.customer?.companyName ?? inquiry.parsedCustomerName ?? 'Inquiry'}
        description={`${inquiry.channel.toLowerCase().replace('_', ' ')} · ${formatDateTime(
          inquiry.createdAt,
          session.locale,
          session.timezone,
        )}`}
        action={<Badge tone={STATUS_TONE[inquiry.status]}>{t(statusKey(inquiry.status))}</Badge>}
      />

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">{t('inquiry.originalMessage')}</h2>
        <Card className="bg-surface-sunken">
          {/* Verbatim, whitespace preserved. This is evidence, not a summary. */}
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">
            {inquiry.rawMessage}
          </p>
        </Card>
      </section>

      {inquiry.status === 'RECEIVED' || inquiry.status === 'PARSE_FAILED' ? (
        <section className="mb-6 space-y-3">
          {inquiry.status === 'PARSE_FAILED' ? (
            <Card className="border-critical/30 bg-critical-soft">
              <h3 className="text-sm font-semibold text-critical">{t('inquiry.parseFailed')}</h3>
              <p className="mt-1 text-sm text-ink">
                Nothing was changed and the message above is untouched. You can try again, or
                enter the lines by hand once it has been parsed.
              </p>
              {inquiry.parseError ? (
                <p className="mt-2 font-mono text-xs break-all text-ink-muted">
                  {inquiry.parseError}
                </p>
              ) : null}
            </Card>
          ) : null}
          {canParse ? (
            <ParseButton inquiryId={inquiry.id} again={inquiry.status === 'PARSE_FAILED'} />
          ) : null}
        </section>
      ) : null}

      {inquiry.parsedAt ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('inquiry.parsedContext')}</h2>
          <Card className="grid gap-3 text-sm sm:grid-cols-4">
            <Fact label={t('inquiry.intent')} value={inquiry.intent.toLowerCase().replace(/_/g, ' ')} />
            <Fact label={t('inquiry.language')} value={inquiry.detectedLanguage ?? '—'} />
            <Fact label={t('inquiry.destination')} value={inquiry.destinationText ?? '—'} />
            <Fact
              label={t('inquiry.customer')}
              value={inquiry.customer?.companyName ?? inquiry.parsedCustomerName ?? '—'}
            />
          </Card>
        </section>
      ) : null}

      {inquiry.status === 'READY_FOR_QUOTE' ? (
        <Card className="mb-6 border-positive/30 bg-positive-soft">
          <h3 className="text-sm font-semibold text-positive">{t('inquiry.ready')}</h3>
          <p className="mt-1 text-sm text-ink">{t('inquiry.readyExplain')}</p>

          {can(session.role, 'create:quotation') ? (
            inquiry.customer ? (
              <div className="mt-4">
                <CreateQuotationForm
                  inquiryId={inquiry.id}
                  creditAllowed={creditAllowed}
                />
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-muted">
                Attach a customer to this inquiry before drafting a quotation.
              </p>
            )
          ) : null}
        </Card>
      ) : null}

      {inquiry.items.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('inquiry.requestedItems')}</h2>
          <div className="space-y-3">
            {inquiry.items.map((item) => (
              <ItemReview
                key={item.id}
                inquiryId={inquiry.id}
                editable={editable}
                products={productOptions}
                item={{
                  id: item.id,
                  position: item.position,
                  rawName: item.rawName,
                  requestedQuantity: item.requestedQuantity,
                  requestedUnit: item.requestedUnit,
                  matchMethod: item.matchMethod,
                  matchReason: item.matchReason,
                  ambiguous: item.ambiguous,
                  proposedConfidence: item.proposedConfidence,
                  band: item.band,
                  reviewStatus: item.reviewStatus,
                  candidates: item.candidates.map((candidate) => ({
                    productId: candidate.productId,
                    sku: candidate.sku,
                    name: candidate.name,
                    confidence: candidate.confidence,
                  })),
                  product: item.product
                    ? {
                        id: item.product.id,
                        sku: item.product.sku,
                        name: item.product.name,
                        unit: item.product.unit,
                        // The authoritative price, read from the catalogue — never from the model.
                        priceDisplay: formatMoney({
                          amountMinor: item.product.sellingPriceMinor,
                          currency: session.currency,
                        }),
                        freeStock: item.product.freeStock,
                      }
                    : null,
                  unitCompatibility: item.unitCheck?.compatibility ?? null,
                  unitReason: item.unitCheck?.reason ?? null,
                  stockShortfall: item.stockShortfall,
                }}
              />
            ))}
          </div>
        </section>
      ) : inquiry.parsedAt ? (
        <Card className="mb-6 border-dashed">
          <p className="text-sm text-ink-muted">{t('inquiry.noItems')}</p>
        </Card>
      ) : null}

      {editable ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('inquiry.addItem')}</h2>
          <Card>
            <AddItemForm inquiryId={inquiry.id} products={productOptions} />
          </Card>
        </section>
      ) : null}

      {inquiry.status === 'NEEDS_REVIEW' ? (
        <section className="mb-6 space-y-4">
          {inquiry.readiness.blockers.length > 0 ? (
            <Card className="border-caution/30 bg-caution-soft">
              <h3 className="text-sm font-semibold text-ink">{t('inquiry.blockers')}</h3>
              <ul className="mt-2 space-y-1 text-sm text-ink">
                {inquiry.readiness.blockers.map((blocker, index) => (
                  <li key={index}>· {blocker.message}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          {inquiry.readiness.warnings.length > 0 ? (
            <Card>
              <h3 className="text-sm font-semibold text-ink">{t('inquiry.warnings')}</h3>
              <ul className="mt-2 space-y-1 text-sm text-ink-muted">
                {inquiry.readiness.warnings.map((warning, index) => (
                  <li key={index}>· {warning.message}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-faint">
                Short stock does not stop a quotation being prepared.
              </p>
            </Card>
          ) : null}

          {can(session.role, 'mark:inquiry-ready') ? (
            <MarkReadyButton inquiryId={inquiry.id} disabled={!inquiry.readiness.ready} />
          ) : null}
        </section>
      ) : null}

      {history.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('activity.title')}</h2>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('activity.action')}</Th>
                <Th>{t('activity.actor')}</Th>
                <Th>{t('activity.when')}</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <Td className="font-mono text-xs">{entry.action}</Td>
                  <Td className="text-ink-muted">
                    {entry.aiInvolved ? (
                      <Badge tone="accent">{t('inquiry.aiSuggested')}</Badge>
                    ) : entry.actorType === 'USER' ? (
                      'User'
                    ) : (
                      t('activity.system')
                    )}
                  </Td>
                  <Td className="text-ink-muted whitespace-nowrap">
                    {formatDateTime(entry.createdAt, session.locale, session.timezone)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>
      ) : null}

      {inquiry.items.length === 0 && !inquiry.parsedAt && inquiry.status === 'RECEIVED' ? (
        <EmptyState message="Run the parser to read this message into requested items." />
      ) : null}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs tracking-wide text-ink-muted uppercase">{label}</div>
      <div className="mt-0.5 text-ink">{value}</div>
    </div>
  );
}
