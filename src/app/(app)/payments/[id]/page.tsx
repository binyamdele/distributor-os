import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { assessPayment, getPayment } from '@/modules/payments';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { formatMoney } from '@/platform/money';
import { formatDate, formatDateTime, t } from '@/platform/i18n';
import { Badge, Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { PAYMENT_STATE_TONE, methodKey, paymentStateKey } from '../page';
import { ConfirmForm, CorrectForm, ExtractForm, RejectForm } from './review-forms';

/**
 * The finance review screen.
 *
 * Laid out as two columns on purpose: what the order says on one side, what was entered on the
 * other, and the checks between them. The reviewer's job is to look at three things — the file,
 * the figures, and the order — and the screen's job is to put all three in front of them without
 * summarising any of it into a verdict.
 *
 * There is no score. Every check is a named factor with a severity, phrased as an observation
 * about two values rather than a recommendation, because the moment a screen says "94% match"
 * people stop reading the receipt.
 */
export default async function PaymentReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission('review:payment');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const payment = await getPayment(tx, id);
    if (!payment.ok) return null;
    const assessment = await assessPayment(tx, session.organizationId, id);
    return {
      payment: payment.value,
      assessment: assessment.ok ? assessment.value : null,
      history: can(session.role, 'read:audit') ? await auditTrailFor(tx, 'payment', id) : [],
    };
  });

  if (!data) notFound();
  const { payment, assessment, history } = data;

  const fmt = (amountMinor: bigint) =>
    formatMoney({ amountMinor, currency: payment.currency });

  const decided = payment.status === 'CONFIRMED' || payment.status === 'REJECTED';
  const blocking = assessment?.factors.filter((factor) => factor.severity === 'BLOCKING') ?? [];
  const factors = assessment?.factors ?? payment.storedFactors;

  return (
    <>
      <PageHeader
        title={t('pay.reviewTitle')}
        description={`${payment.customer.companyName} · ${payment.order.orderNumber}`}
        action={
          <Badge tone={PAYMENT_STATE_TONE[payment.status]}>
            {t(paymentStateKey(payment.status))}
          </Badge>
        }
      />

      {payment.status === 'REJECTED' && payment.rejectionReason ? (
        <Card className="mb-6 border-critical/30 bg-critical-soft">
          <p className="text-sm text-ink">{payment.rejectionReason}</p>
        </Card>
      ) : null}

      {/* --- order beside entry, so the comparison is the layout ------------- */}
      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card className="space-y-1.5 text-sm">
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('pay.whatTheOrderSays')}</h2>
          <Row label={t('order.number')} value={payment.order.orderNumber} />
          <Row label={t('pay.orderTotal')} value={fmt(payment.order.grandTotalMinor)} />
          <Row label={t('pay.confirmed')} value={fmt(payment.balance.confirmedMinor)} />
          <Row
            label={t('pay.outstanding')}
            value={fmt(payment.balance.outstandingMinor)}
            emphasis
          />
          {payment.balance.overpaidMinor > 0n ? (
            <Row label={t('pay.overpaid')} value={fmt(payment.balance.overpaidMinor)} />
          ) : null}
          <Row
            label={t('quote.paymentTerms')}
            value={
              payment.order.paymentType === 'CASH'
                ? t('quote.cash')
                : `Credit — ${payment.order.paymentTermsDays} days`
            }
          />
          <Row
            label={t('order.fulfillmentStatus')}
            value={payment.order.fulfillmentStatus.replace(/_/g, ' ').toLowerCase()}
          />
          <div className="pt-1">
            <Link
              href={`/orders/${payment.order.id}`}
              className="font-mono text-sm text-accent hover:underline"
            >
              {payment.order.orderNumber}
            </Link>
          </div>
        </Card>

        <Card className="space-y-1.5 text-sm">
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('pay.whatWasEntered')}</h2>
          <Row label={t('pay.claimed')} value={fmt(payment.amountClaimedMinor)} emphasis />
          <Row label={t('pay.method')} value={t(methodKey(payment.method))} />
          <Row label={t('pay.provider')} value={payment.providerName ?? '—'} />
          <Row label={t('pay.reference')} value={payment.transactionReference ?? '—'} mono />
          <Row label={t('pay.payer')} value={payment.payerName ?? '—'} />
          <Row
            label={t('pay.date')}
            value={
              payment.paymentDate
                ? formatDate(payment.paymentDate, session.locale, session.timezone)
                : '—'
            }
          />
          <Row
            label={t('pay.submittedAt')}
            value={formatDateTime(payment.submittedAt, session.locale, session.timezone)}
          />
        </Card>
      </section>

      {/* --- the file itself ------------------------------------------------- */}
      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card className="text-sm">
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('pay.evidenceFile')}</h2>
          {payment.evidence ? (
            <div className="space-y-1.5">
              <a
                href={`/payments/evidence/${payment.evidence.id}`}
                className="text-accent hover:underline"
                data-testid="evidence-link"
              >
                {t('pay.openEvidence')}
              </a>
              <Row label="Type" value={payment.evidence.mimeType} mono />
              <Row label="Size" value={`${Math.ceil(payment.evidence.sizeBytes / 1024)} KB`} />
              {/* Shown because a confirmation is bound to these exact bytes. Swapping the file
                  after the fact produces a different hash and a different payload. */}
              <Row
                label={t('pay.contentHash')}
                value={payment.evidence.contentHash.slice(0, 16)}
                mono
              />
            </div>
          ) : (
            <p className="text-ink-muted">{t('pay.noEvidence')}</p>
          )}
        </Card>

        <Card className="text-sm">
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('pay.extraction')}</h2>
          {payment.extractionStatus === 'SUCCEEDED' ? (
            <p className="text-ink-muted">{t('pay.extractionOk')}</p>
          ) : payment.extractionStatus === 'NOT_ATTEMPTED' ? (
            <p className="text-ink-muted">{t('pay.extractionNever')}</p>
          ) : (
            <p className="text-ink-muted" data-testid="extraction-failed">
              {t('pay.extractionFailed')}
              {payment.extractionError ? (
                <span className="ml-1 font-mono text-xs text-ink-faint">
                  ({payment.extractionError})
                </span>
              ) : null}
            </p>
          )}
          <p className="mt-2 text-xs text-ink-faint">{t('pay.extractHint')}</p>
          {!decided && payment.evidence ? (
            <div className="mt-3">
              <ExtractForm paymentId={payment.id} />
            </div>
          ) : null}
        </Card>
      </section>

      {/* --- the checks, named and severity-tagged --------------------------- */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">{t('pay.checks')}</h2>
        {factors.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-muted">{t('pay.noFactors')}</p>
          </Card>
        ) : (
          <ul className="space-y-2">
            {factors.map((factor) => (
              <li key={factor.code} data-testid="match-factor" data-code={factor.code}>
                <Card
                  className={
                    factor.severity === 'BLOCKING'
                      ? 'border-critical/30 bg-critical-soft'
                      : factor.severity === 'WARNING'
                        ? 'border-caution/30 bg-caution-soft'
                        : undefined
                  }
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Badge
                      tone={
                        factor.severity === 'BLOCKING'
                          ? 'critical'
                          : factor.severity === 'WARNING'
                            ? 'caution'
                            : 'neutral'
                      }
                    >
                      {factor.severity}
                    </Badge>
                    <span className="font-mono text-xs text-ink-faint">{factor.code}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-ink">{factor.detail}</p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- the decision ---------------------------------------------------- */}
      {!decided && assessment ? (
        <section className="mb-6 space-y-4">
          {can(session.role, 'review:payment') ? (
            <Card>
              <h2 className="mb-1 text-sm font-semibold text-ink">{t('pay.correct')}</h2>
              <p className="mb-3 text-xs text-ink-faint">{t('pay.correctHint')}</p>
              <CorrectForm
                paymentId={payment.id}
                defaults={{
                  amountClaimed: decimalString(payment.amountClaimedMinor),
                  method: payment.method,
                  providerName: payment.providerName ?? '',
                  transactionReference: payment.transactionReference ?? '',
                  payerName: payment.payerName ?? '',
                  paymentDate: payment.paymentDate
                    ? payment.paymentDate.toISOString().slice(0, 10)
                    : '',
                }}
              />
            </Card>
          ) : null}

          {can(session.role, 'confirm:payment') ? (
            <Card>
              {blocking.length > 0 ? (
                <p className="mb-3 text-sm text-critical" data-testid="confirm-blocked">
                  {t('pay.blocked')}
                </p>
              ) : null}
              <ConfirmForm
                paymentId={payment.id}
                payloadHash={assessment.payloadHash}
                blocked={blocking.length > 0}
              />
              <p className="mt-2 text-xs text-ink-faint">{t('pay.confirmDisclaimer')}</p>
            </Card>
          ) : null}

          {can(session.role, 'reject:payment') ? (
            <Card>
              <RejectForm paymentId={payment.id} />
            </Card>
          ) : null}
        </section>
      ) : null}

      {payment.status === 'CONFIRMED' && payment.confirmationPayloadHash ? (
        <Card className="mb-6 text-sm">
          <Row label={t('pay.confirmed')} value={fmt(payment.amountConfirmedMinor ?? 0n)} />
          {payment.reviewedAt ? (
            <Row
              label={t('pay.reviewedAt')}
              value={formatDateTime(payment.reviewedAt, session.locale, session.timezone)}
            />
          ) : null}
          <Row
            label="Confirmation fingerprint"
            value={payment.confirmationPayloadHash.slice(0, 16)}
            mono
          />
        </Card>
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

/** Minor units to the decimal string the correction form edits. */
function decimalString(minor: bigint): string {
  const absolute = minor < 0n ? -minor : minor;
  return `${minor < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function Row({
  label,
  value,
  mono,
  emphasis,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-muted">{label}</span>
      <span
        className={[
          mono ? 'font-mono text-xs' : 'tabular',
          emphasis ? 'font-semibold text-ink' : 'text-ink',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}
