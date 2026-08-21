import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { aggregateByCustomer, receivables } from '@/modules/payments';
import { formatMoney } from '@/platform/money';
import { formatDate, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, Card, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

const BUCKET_TONE = {
  OVERDUE: 'critical',
  DUE_TODAY: 'caution',
  DUE_SOON: 'accent',
  NOT_DUE: 'neutral',
} as const;

/**
 * What is owed, and who to call first.
 *
 * Derived entirely from open orders and their confirmed payments at the moment the page is
 * requested. There is no receivables table, no nightly job and no scheduler — a stored balance
 * would only be another thing that can drift from the payments that actually exist.
 *
 * The ordering is deliberately dull: overdue first, longest overdue next, largest next. A clerk
 * can predict it, which is the property that makes a collections list get used.
 */
export default async function ReceivablesPage() {
  const session = await requirePermission('read:receivables');

  const rows = await withTenant(session.organizationId, (tx) => receivables(tx));
  const byCustomer = aggregateByCustomer(rows);
  const currency = rows[0]?.currency ?? 'ETB';
  const total = rows.reduce((sum, row) => sum + row.outstandingMinor, 0n);

  return (
    <>
      <PageHeader title={t('recv.title')} description={t('recv.hint')} />

      {rows.length > 0 ? (
        <Card className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-ink-muted">{t('recv.totalOutstanding')}</span>
          <span className="tabular text-lg font-semibold text-ink" data-testid="receivables-total">
            {formatMoney({ amountMinor: total, currency })}
          </span>
        </Card>
      ) : null}

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('order.number')}</Th>
            <Th>{t('quote.customer')}</Th>
            <Th className="text-right">{t('pay.orderTotal')}</Th>
            <Th className="text-right">{t('pay.confirmed')}</Th>
            <Th className="text-right">{t('pay.outstanding')}</Th>
            <Th>{t('recv.due')}</Th>
            <Th className="text-right">{t('recv.daysOverdue')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.orderId} data-testid="receivable-row" data-order={row.orderNumber}>
              <Td>
                <Link
                  href={`/orders/${row.orderId}`}
                  className="font-mono text-accent hover:underline"
                >
                  {row.orderNumber}
                </Link>
              </Td>
              <Td>
                <div>{row.customerName}</div>
                {row.customerPhone ? (
                  <div className="text-xs text-ink-faint">{row.customerPhone}</div>
                ) : null}
              </Td>
              <Td className="tabular text-right text-ink-muted">
                {formatMoney({ amountMinor: row.orderTotalMinor, currency: row.currency })}
              </Td>
              <Td className="tabular text-right text-ink-muted">
                {formatMoney({ amountMinor: row.confirmedMinor, currency: row.currency })}
              </Td>
              <Td className="tabular text-right font-medium">
                {formatMoney({ amountMinor: row.outstandingMinor, currency: row.currency })}
              </Td>
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={BUCKET_TONE[row.bucket]}>
                    {t(`bucket.${row.bucket}` as MessageKey)}
                  </Badge>
                  <span className="text-xs whitespace-nowrap text-ink-muted">
                    {row.dueDate
                      ? formatDate(row.dueDate, session.locale, session.timezone)
                      : '—'}
                  </span>
                </div>
              </Td>
              <Td className="tabular text-right">{row.daysOverdue > 0 ? row.daysOverdue : '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {rows.length === 0 ? <EmptyState message={t('recv.empty')} /> : null}

      {byCustomer.length > 1 ? (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('recv.byCustomer')}</h2>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('quote.customer')}</Th>
                <Th className="text-right">{t('recv.orders')}</Th>
                <Th className="text-right">{t('pay.outstanding')}</Th>
                <Th className="text-right">{t('bucket.OVERDUE')}</Th>
              </tr>
            </thead>
            <tbody>
              {byCustomer.map((customer) => (
                <tr key={customer.customerId}>
                  <Td>
                    <Link
                      href={`/customers/${customer.customerId}`}
                      className="text-accent hover:underline"
                    >
                      {customer.customerName}
                    </Link>
                  </Td>
                  <Td className="tabular text-right">{customer.orderCount}</Td>
                  <Td className="tabular text-right font-medium">
                    {formatMoney({ amountMinor: customer.outstandingMinor, currency })}
                  </Td>
                  <Td className="tabular text-right">
                    {customer.overdueMinor > 0n
                      ? formatMoney({ amountMinor: customer.overdueMinor, currency })
                      : '—'}
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
