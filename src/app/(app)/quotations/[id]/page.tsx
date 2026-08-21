import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { canRoleApprove, getQuotation } from '@/modules/quotations';
import { listProducts } from '@/modules/catalog';
import { followUpsFor } from '@/modules/followups';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { formatMoney, toDecimalString } from '@/platform/money';
import { formatDate, formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { QUOTE_STATUS_TONE, quoteStatusKey } from '../page';
import { CreateOrderForm, RecordAcceptanceForm, RecordRejectionForm } from '../../orders/order-forms';
import {
  AddLineForm,
  ApprovalForm,
  DeliveryAndTermsForm,
  LineEditForm,
  MarkSentForm,
  SubmitForApprovalForm,
} from './quotation-forms';

/**
 * The quotation screen.
 *
 * Governance is stated on the page, not tucked into a tooltip. Whether approval is possible,
 * who can give it, and whether the approval on file still applies are all rendered as text a
 * salesperson can read and act on.
 */
export default async function QuotationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission('read:quotation');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const quotation = await getQuotation(tx, id);
    if (!quotation.ok) return null;
    return {
      quotation: quotation.value,
      products: await listProducts(tx),
      followUps: await followUpsFor(tx, id),
      existingOrder: await tx.salesOrder.findFirst({
        where: { quotationId: id, status: { not: 'CANCELLED' } },
        select: { id: true, orderNumber: true },
      }),
      history: can(session.role, 'read:audit') ? await auditTrailFor(tx, 'quotation', id) : [],
    };
  });

  if (!data) notFound();
  const { quotation, products, history, followUps, existingOrder } = data;
  const currency = quotation.currency;
  const fmt = (amountMinor: bigint) => formatMoney({ amountMinor, currency });

  const editable =
    can(session.role, 'edit:quotation') &&
    (quotation.status === 'DRAFT' ||
      quotation.status === 'PENDING_APPROVAL' ||
      quotation.status === 'APPROVED');

  const roleCanApprove = canRoleApprove(session.role, quotation.requirement.level);
  const holdsApprovalPermission =
    quotation.requirement.level === 'SALES_MANAGER'
      ? can(session.role, 'approve:quotation:manager_limit')
      : can(session.role, 'approve:quotation:self_limit');

  const canApproveNow =
    quotation.status === 'PENDING_APPROVAL' &&
    !quotation.requirement.blocked &&
    roleCanApprove &&
    holdsApprovalPermission;

  const blockingReason = quotation.requirement.reasons.find(
    (reason) => reason.code !== 'DISCOUNT_WITHIN_SALESPERSON_LIMIT',
  );

  return (
    <>
      <PageHeader
        title={quotation.quotationNumber}
        description={`${quotation.customer.companyName} · ${formatDate(
          quotation.createdAt,
          session.locale,
          session.timezone,
        )}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={QUOTE_STATUS_TONE[quotation.status]}>
              {t(quoteStatusKey(quotation.status))}
            </Badge>
            {quotation.status === 'APPROVED' && !quotation.approvalIsLive ? (
              <Badge tone="critical">{t('quote.approvalInvalidated')}</Badge>
            ) : null}
          </div>
        }
      />

      {/* --- governance, stated plainly ------------------------------------ */}
      <Card
        className={
          quotation.requirement.blocked
            ? 'mb-6 border-critical/30 bg-critical-soft'
            : quotation.requirement.level === 'SALES_MANAGER'
              ? 'mb-6 border-caution/30 bg-caution-soft'
              : 'mb-6'
        }
      >
        <h2 className="text-sm font-semibold text-ink">{t('quote.approval')}</h2>
        <p className="mt-1 text-sm text-ink">
          {quotation.requirement.blocked
            ? t('quote.approvalBlocked')
            : quotation.requirement.level === 'SALES_MANAGER'
              ? t('quote.approvalManager')
              : t('quote.approvalSalesperson')}
        </p>
        <ul className="mt-2 space-y-1 text-sm text-ink-muted">
          {quotation.requirement.reasons.map((reason, index) => (
            <li key={index}>· {reason.message}</li>
          ))}
        </ul>

        {quotation.approvalIsLive && quotation.approvedAt ? (
          <p className="mt-3 text-sm text-positive">
            {t('quote.approvedBy')} ·{' '}
            {formatDateTime(quotation.approvedAt, session.locale, session.timezone)}
          </p>
        ) : null}

        {quotation.status === 'APPROVED' && !quotation.approvalIsLive ? (
          <p className="mt-3 text-sm text-critical">{t('quote.approvalInvalidated')}</p>
        ) : null}
      </Card>

      {/* --- lines --------------------------------------------------------- */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">{t('quote.lines')}</h2>
        <p className="mb-3 text-xs text-ink-faint">{t('quote.snapshotNote')}</p>

        <TableWrap>
          <thead>
            <tr>
              <Th>Product</Th>
              <Th className="text-right">{t('quote.quantity')}</Th>
              <Th className="text-right">{t('quote.listPrice')}</Th>
              <Th className="text-right">{t('quote.discount')}</Th>
              <Th className="text-right">{t('quote.quotedPrice')}</Th>
              <Th className="text-right">{t('quote.lineTax')}</Th>
              <Th className="text-right">{t('quote.lineTotal')}</Th>
            </tr>
          </thead>
          <tbody>
            {quotation.lines.map((line) => (
              <tr key={line.id} data-testid="quotation-line" data-sku={line.sku}>
                <Td>
                  <div className="font-medium text-ink">{line.description}</div>
                  <div className="font-mono text-xs text-ink-faint">{line.sku}</div>
                  {/* Live stock, clearly separated from the quoted figures. Quoting reserves
                      nothing, and the wording must not imply that it does. */}
                  {line.currentStock !== null ? (
                    <div className="mt-0.5 text-xs text-ink-muted">
                      {t('quote.stockContext')}: {line.currentStock.toLocaleString()} {line.unit}
                      {line.currentStock < line.quantity ? (
                        <span className="ml-1 text-caution">· short</span>
                      ) : null}
                    </div>
                  ) : null}
                  {line.priceHasMoved ? (
                    <div className="mt-0.5 text-xs text-caution">{t('quote.priceMoved')}</div>
                  ) : null}
                </Td>
                <Td className="tabular text-right">
                  {line.quantity.toLocaleString()} {line.unit}
                </Td>
                <Td className="tabular text-right text-ink-muted">
                  {fmt(line.listUnitPriceMinor)}
                </Td>
                <Td className="tabular text-right">
                  {line.discountBp > 0 ? `${(line.discountBp / 100).toFixed(2)}%` : '—'}
                </Td>
                <Td className="tabular text-right">{fmt(line.effectiveUnitPriceMinor)}</Td>
                <Td className="tabular text-right text-ink-muted">{fmt(line.taxMinor)}</Td>
                <Td className="tabular text-right font-medium">{fmt(line.lineTotalMinor)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>

        {editable ? (
          <div className="mt-4 space-y-4">
            {quotation.lines.map((line) => (
              <Card key={line.id} className="py-3">
                <div className="mb-2 text-xs font-medium text-ink-muted">{line.description}</div>
                <LineEditForm
                  quotationId={quotation.id}
                  lineId={line.id}
                  quantity={line.quantity}
                  discountPercent={(line.discountBp / 100).toFixed(2)}
                  description={line.description}
                />
              </Card>
            ))}
            <Card>
              <AddLineForm
                quotationId={quotation.id}
                products={products.map((product) => ({
                  id: product.id,
                  sku: product.sku,
                  name: product.name,
                }))}
              />
            </Card>
          </div>
        ) : null}
      </section>

      {/* --- totals -------------------------------------------------------- */}
      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="space-y-1.5 text-sm">
          <Row label={t('quote.subtotal')} value={fmt(quotation.subtotalMinor)} />
          {quotation.discountTotalMinor > 0n ? (
            <Row
              label={t('quote.discountTotal')}
              value={`− ${fmt(quotation.discountTotalMinor)}`}
              tone="caution"
            />
          ) : null}
          {quotation.deliveryFeeMinor > 0n ? (
            <Row label={t('quote.deliveryFee')} value={fmt(quotation.deliveryFeeMinor)} />
          ) : null}
          {quotation.deliveryTaxMinor > 0n ? (
            <Row label={t('quote.deliveryTax')} value={fmt(quotation.deliveryTaxMinor)} />
          ) : null}
          <Row label={t('quote.taxTotal')} value={fmt(quotation.taxTotalMinor)} />
          <div className="mt-2 flex justify-between border-t border-border-subtle pt-2 text-base font-semibold">
            <span>{t('quote.grandTotal')}</span>
            <span className="tabular" data-testid="grand-total">
              {fmt(quotation.grandTotalMinor)}
            </span>
          </div>
          {!quotation.deliveryFeeTaxable && quotation.deliveryFeeMinor > 0n ? (
            <p className="pt-1 text-xs text-ink-faint">
              Delivery is not taxed for this organization.
            </p>
          ) : null}
        </Card>

        <Card className="space-y-2 text-sm">
          <Row
            label={t('quote.paymentTerms')}
            value={
              quotation.paymentType === 'CASH'
                ? t('quote.cash')
                : `Credit — ${quotation.paymentTermsDays} days`
            }
          />
          <Row
            label={t('quote.validUntil')}
            value={formatDate(quotation.validityDate, session.locale, session.timezone)}
          />
          <Row label="Credit standing" value={quotation.customer.creditStatus} />
          {quotation.inquiryId ? (
            <div className="pt-1">
              <Link
                href={`/inquiries/${quotation.inquiryId}`}
                className="text-sm text-accent hover:underline"
              >
                {t('quote.sourceInquiry')}
              </Link>
            </div>
          ) : null}

          {editable ? (
            <div className="border-t border-border-subtle pt-3">
              <DeliveryAndTermsForm
                quotationId={quotation.id}
                deliveryFee={toDecimalString({
                  amountMinor: quotation.deliveryFeeMinor,
                  currency,
                })}
                paymentType={quotation.paymentType}
                paymentTermsDays={quotation.paymentTermsDays}
                creditAllowed={quotation.customer.creditStatus === 'CREDIT_ALLOWED'}
                currency={currency}
              />
            </div>
          ) : null}
        </Card>
      </section>

      {/* --- actions ------------------------------------------------------- */}
      <section className="mb-6 space-y-4">
        {quotation.status === 'DRAFT' && can(session.role, 'submit:quotation') ? (
          quotation.requirement.blocked ? (
            <Card className="border-critical/30 bg-critical-soft">
              <p className="text-sm text-ink">
                {blockingReason?.message ?? t('quote.approvalBlocked')}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                Change the figures above; there is no signature that unlocks this.
              </p>
            </Card>
          ) : (
            <SubmitForApprovalForm quotationId={quotation.id} />
          )
        ) : null}

        {quotation.status === 'PENDING_APPROVAL' && holdsApprovalPermission ? (
          <ApprovalForm
            quotationId={quotation.id}
            payloadHash={quotation.currentPayloadHash}
            canApprove={canApproveNow}
            blockedReason={
              quotation.requirement.blocked
                ? (blockingReason?.message ?? t('quote.approvalBlocked'))
                : !roleCanApprove
                  ? t('quote.approvalManager')
                  : null
            }
          />
        ) : null}

        {quotation.status === 'PENDING_APPROVAL' && !holdsApprovalPermission ? (
          <Card className="border-dashed">
            <p className="text-sm text-ink-muted">{t('quote.notYours')}</p>
          </Card>
        ) : null}

        {quotation.status === 'APPROVED' && can(session.role, 'mark:quotation-sent') ? (
          <MarkSentForm
            quotationId={quotation.id}
            disabled={!quotation.approvalIsLive}
            disabledReason={
              quotation.approvalIsLive ? null : `${t('quote.approvalInvalidated')}.`
            }
          />
        ) : null}

        {quotation.status === 'SENT' && quotation.sentAt ? (
          <Card className="border-accent/30 bg-accent-soft">
            <p className="text-sm text-ink">
              Marked sent {formatDateTime(quotation.sentAt, session.locale, session.timezone)}.
            </p>
            <p className="mt-1 text-xs text-ink-muted">{t('quote.sentNote')}</p>
          </Card>
        ) : null}

        {/* --- Phase 4: what the customer said, and what follows from it ----- */}
        {quotation.status === 'SENT' && can(session.role, 'record:quotation-acceptance') ? (
          <Card>
            <h3 className="text-sm font-semibold text-ink">{t('accept.title')}</h3>
            <div className="mt-3">
              <RecordAcceptanceForm quotationId={quotation.id} />
            </div>
          </Card>
        ) : null}

        {quotation.status === 'SENT' && can(session.role, 'record:quotation-rejection') ? (
          <Card>
            <h3 className="text-sm font-semibold text-ink">{t('reject.title')}</h3>
            <div className="mt-3">
              <RecordRejectionForm quotationId={quotation.id} />
            </div>
          </Card>
        ) : null}

        {quotation.status === 'ACCEPTED' ? (
          <Card className="border-positive/30 bg-positive-soft">
            <h3 className="text-sm font-semibold text-positive">{t('accept.recorded')}</h3>
            {existingOrder ? (
              <p className="mt-2 text-sm text-ink">
                Converted to{' '}
                <Link
                  href={`/orders/${existingOrder.id}`}
                  className="font-mono text-accent hover:underline"
                >
                  {existingOrder.orderNumber}
                </Link>
                .
              </p>
            ) : can(session.role, 'create:sales-order') ? (
              <div className="mt-3">
                {/* Stock is checked here, not at acceptance. The yard may have changed since the
                    quotation went out, and that is a real thing the salesperson must be told. */}
                <CreateOrderForm quotationId={quotation.id} />
              </div>
            ) : null}
          </Card>
        ) : null}

        {quotation.status === 'REJECTED' ? (
          <Card>
            <h3 className="text-sm font-semibold text-ink">{t('reject.recorded')}</h3>
          </Card>
        ) : null}
      </section>

      {followUps.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('followUp.history')}</h2>
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-20 text-right">{t('followUp.attempt')}</Th>
                <Th>{t('followUp.dueAt')}</Th>
                <Th>Status</Th>
                <Th>{t('followUp.outcome')}</Th>
                <Th>{t('followUp.note')}</Th>
              </tr>
            </thead>
            <tbody>
              {followUps.map((followUp) => (
                <tr key={followUp.id}>
                  <Td className="tabular text-right">{followUp.sequence}</Td>
                  <Td className="text-ink-muted whitespace-nowrap">
                    {formatDate(followUp.dueAt, session.locale, session.timezone)}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        followUp.status === 'COMPLETED'
                          ? 'positive'
                          : followUp.status === 'CANCELLED'
                            ? 'neutral'
                            : 'caution'
                      }
                    >
                      {followUp.status}
                    </Badge>
                  </Td>
                  <Td className="text-ink-muted">
                    {followUp.outcome ? t(`outcome.${followUp.outcome}` as MessageKey) : '—'}
                  </Td>
                  <Td className="text-ink-muted">{followUp.note ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>
      ) : null}

      {/* --- approval history ---------------------------------------------- */}
      {quotation.approvals.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('quote.approvalHistory')}</h2>
          <TableWrap>
            <thead>
              <tr>
                <Th>Decision</Th>
                <Th>Role</Th>
                <Th>Required</Th>
                <Th>Figures</Th>
                <Th>{t('activity.when')}</Th>
              </tr>
            </thead>
            <tbody>
              {quotation.approvals.map((approval) => (
                <tr key={approval.id}>
                  <Td>
                    <Badge tone={approval.decision === 'APPROVED' ? 'positive' : 'critical'}>
                      {approval.decision}
                    </Badge>
                  </Td>
                  <Td className="text-ink-muted">{approval.approverRole}</Td>
                  <Td className="text-ink-muted">{approval.requiredLevel}</Td>
                  <Td>
                    {/* The hash is what makes "who approved which version" answerable. */}
                    <span className="font-mono text-xs text-ink-faint">
                      {approval.payloadHash.slice(0, 12)}
                    </span>
                    {approval.matchesCurrent ? (
                      <Badge tone="positive" className="ml-2">
                        current
                      </Badge>
                    ) : (
                      <Badge className="ml-2">superseded</Badge>
                    )}
                  </Td>
                  <Td className="text-ink-muted whitespace-nowrap">
                    {formatDateTime(approval.createdAt, session.locale, session.timezone)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('activity.title')}</h2>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('activity.action')}</Th>
                <Th>{t('activity.when')}</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <Td className="font-mono text-xs">{entry.action}</Td>
                  <Td className="text-ink-muted whitespace-nowrap">
                    {formatDateTime(entry.createdAt, session.locale, session.timezone)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>
      ) : null}
    </>
  );
}

function Row({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'caution';
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-muted">{label}</span>
      <span className={`tabular ${tone === 'caution' ? 'text-caution' : 'text-ink'}`}>{value}</span>
    </div>
  );
}
