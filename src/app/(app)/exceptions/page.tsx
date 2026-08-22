import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { inventoryExceptions, unresolvedFailures } from '@/modules/inventory';
import { formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, Card, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

export const DISCREPANCY_TONE = {
  OPEN: 'critical',
  UNDER_REVIEW: 'caution',
  RESOLVED: 'positive',
  CANCELLED: 'neutral',
} as const;

export function discrepancyStatusKey(status: string): MessageKey {
  return `excStatus.${status.toLowerCase()}` as MessageKey;
}

export const ORDER_EXCEPTION_TONE = {
  STOCK_SHORTFALL: 'critical',
  DELIVERY_FAILED: 'caution',
  DELIVERY_LOST: 'critical',
  GOODS_RETURNED: 'caution',
} as const;

export function orderExceptionKey(exception: string): MessageKey {
  return `orderExc.${exception.toLowerCase()}` as MessageKey;
}

/**
 * The exceptions list: both classes of fulfilment problem in one place.
 *
 * Pre-handoff, where the yard and the system disagree about what is on the shelf. Post-handoff,
 * where goods have left and did not arrive. They are different problems with different
 * remedies, so they are two tables rather than one merged list that would blur them.
 */
export default async function ExceptionsPage() {
  const session = await requirePermission('read:inventory-exception');

  const { counts, failures } = await withTenant(session.organizationId, async (tx) => ({
    counts: await inventoryExceptions(tx),
    failures: await unresolvedFailures(tx),
  }));

  return (
    <>
      <PageHeader title={t('exc.title')} description={t('exc.hint')} />

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">{t('exc.counts')}</h2>
        <TableWrap>
          <thead>
            <tr>
              <Th>{t('exc.number')}</Th>
              <Th>Product</Th>
              <Th className="text-right">{t('exc.systemOnHand')}</Th>
              <Th className="text-right">{t('exc.reserved')}</Th>
              <Th className="text-right">{t('exc.counted')}</Th>
              <Th className="text-right">{t('exc.variance')}</Th>
              <Th>{t('quote.status')}</Th>
              <Th>{t('exc.reportedBy')}</Th>
              <Th className="text-right">{t('exc.age')}</Th>
            </tr>
          </thead>
          <tbody>
            {counts.map((row) => (
              <tr key={row.id} data-testid="exception-row" data-sku={row.sku}>
                <Td>
                  <Link
                    href={`/exceptions/${row.id}`}
                    className="font-mono text-accent hover:underline"
                  >
                    {row.discrepancyNumber}
                  </Link>
                  {row.taskNumber ? (
                    <div className="font-mono text-xs text-ink-faint">{row.taskNumber}</div>
                  ) : null}
                </Td>
                <Td>
                  <div className="font-medium text-ink">{row.description}</div>
                  <div className="font-mono text-xs text-ink-faint">{row.sku}</div>
                </Td>
                <Td className="tabular text-right">{row.systemOnHand.toLocaleString()}</Td>
                <Td className="tabular text-right text-ink-muted">
                  {row.systemReserved.toLocaleString()}
                </Td>
                <Td className="tabular text-right font-medium">
                  {row.physicalCount.toLocaleString()}
                </Td>
                <Td
                  className={`tabular text-right font-medium ${
                    row.variance < 0 ? 'text-critical' : 'text-positive'
                  }`}
                >
                  {row.variance > 0 ? '+' : ''}
                  {row.variance.toLocaleString()}
                </Td>
                <Td>
                  <Badge tone={DISCREPANCY_TONE[row.status]}>
                    {t(discrepancyStatusKey(row.status))}
                  </Badge>
                  {row.reservationShortfall ? (
                    <div className="mt-0.5 text-xs text-critical" data-testid="row-shortfall">
                      −{row.reservationShortfall}
                    </div>
                  ) : null}
                </Td>
                <Td className="text-ink-muted">{row.reportedByName ?? '—'}</Td>
                <Td className="tabular text-right text-ink-muted">
                  {row.ageHours}
                  {t('exc.hours')}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        {counts.length === 0 ? <EmptyState message={t('exc.emptyCounts')} /> : null}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t('exc.failures')}</h2>
        <div className="space-y-2">
          {failures.map((row) => (
            <Card
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3"
              data-testid="failure-row"
              data-order={row.orderNumber}
            >
              <div className="min-w-0">
                <Link
                  href={`/deliveries/${row.id}`}
                  className="font-mono text-sm text-accent hover:underline"
                >
                  {row.deliveryNumber}
                </Link>
                <div className="text-sm text-ink-muted">
                  {row.customerName} · {row.orderNumber} · {row.destination}
                </div>
                <div className="text-xs text-ink-faint">
                  {t('fail.attempt')} {row.attemptNumber}
                  {row.failedAt
                    ? ` · ${formatDateTime(row.failedAt, session.locale, session.timezone)}`
                    : ''}
                </div>
              </div>
              {/*
               * Whether the money already arrived, as a flag. It changes the urgency completely:
               * a paid order whose goods did not arrive is an obligation, not just a failed run.
               */}
              {row.paymentSettled ? (
                <Badge tone="critical" data-testid="paid-failure">
                  {t('payStatus.paid')}
                </Badge>
              ) : (
                <Badge tone="neutral">{row.paymentType}</Badge>
              )}
            </Card>
          ))}
        </div>
        {failures.length === 0 ? <EmptyState message={t('exc.emptyFailures')} /> : null}
      </section>
    </>
  );
}
