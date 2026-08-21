import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { paymentsToVerify } from '@/modules/payments';
import { formatMoney } from '@/platform/money';
import { formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

export const PAYMENT_STATE_TONE = {
  SUBMITTED: 'accent',
  NEEDS_REVIEW: 'caution',
  CONFIRMED: 'positive',
  REJECTED: 'neutral',
} as const;

export function paymentStateKey(status: string): MessageKey {
  return `payState.${status.toLowerCase()}` as MessageKey;
}

export function methodKey(method: string): MessageKey {
  return `method.${method}` as MessageKey;
}

/**
 * The finance work queue.
 *
 * Oldest first, and the discrepancy column is computed from stored figures rather than scored by
 * anything — "the claim does not equal what is outstanding" is a fact about two numbers, and a
 * clerk can check it against the receipt in a second. A confidence percentage here would invite
 * exactly the trust this gate exists to withhold.
 */
export default async function PaymentsPage() {
  const session = await requirePermission('review:payment');

  const rows = await withTenant(session.organizationId, (tx) => paymentsToVerify(tx));

  return (
    <>
      <PageHeader title={t('pay.title')} description={t('pay.queueHint')} />

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('order.number')}</Th>
            <Th>{t('quote.customer')}</Th>
            <Th className="text-right">{t('pay.claimed')}</Th>
            <Th className="text-right">{t('pay.outstanding')}</Th>
            <Th>{t('pay.method')}</Th>
            <Th>{t('pay.reference')}</Th>
            <Th>{t('quote.status')}</Th>
            <Th>{t('pay.submittedAt')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid="payment-row" data-order={row.orderNumber}>
              <Td>
                <Link
                  href={`/payments/${row.id}`}
                  className="font-mono text-accent hover:underline"
                >
                  {row.orderNumber}
                </Link>
              </Td>
              <Td>{row.customerName}</Td>
              <Td className="tabular text-right">
                <span className={row.amountDiffers ? 'text-caution' : undefined}>
                  {formatMoney({ amountMinor: row.amountClaimedMinor, currency: row.currency })}
                </span>
              </Td>
              <Td className="tabular text-right text-ink-muted">
                {formatMoney({ amountMinor: row.outstandingMinor, currency: row.currency })}
              </Td>
              <Td>{t(methodKey(row.method))}</Td>
              <Td className="font-mono text-xs">{row.transactionReference ?? '—'}</Td>
              <Td>
                <Badge tone={PAYMENT_STATE_TONE[row.status]}>{t(paymentStateKey(row.status))}</Badge>
              </Td>
              <Td className="text-ink-muted whitespace-nowrap">
                {formatDateTime(row.submittedAt, session.locale, session.timezone)}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {rows.length === 0 ? <EmptyState message={t('pay.empty')} /> : null}
    </>
  );
}
