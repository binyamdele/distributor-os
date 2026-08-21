import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { listOrders } from '@/modules/orders';
import { formatMoney } from '@/platform/money';
import { formatDate, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

export const ORDER_STATUS_TONE = {
  OPEN: 'accent',
  CANCELLED: 'neutral',
  COMPLETED: 'positive',
} as const;

export const PAYMENT_TONE = {
  UNPAID: 'caution',
  PARTIALLY_PAID: 'caution',
  NOT_REQUIRED_YET: 'neutral',
  PAID: 'positive',
} as const;

export const FULFILMENT_TONE = {
  NOT_READY: 'neutral',
  READY: 'positive',
  CANCELLED: 'neutral',
} as const;

export function orderStatusKey(status: string): MessageKey {
  return `orderStatus.${status.toLowerCase()}` as MessageKey;
}
export function paymentStatusKey(status: string): MessageKey {
  return `payStatus.${status.toLowerCase()}` as MessageKey;
}
export function fulfilmentStatusKey(status: string): MessageKey {
  return `fulfilStatus.${status.toLowerCase()}` as MessageKey;
}

export default async function OrdersPage() {
  const session = await requirePermission('read:order');

  const rows = await withTenant(session.organizationId, (tx) => listOrders(tx));

  return (
    <>
      <PageHeader
        title={t('order.title')}
        description="Accepted quotations, with stock held against them."
      />

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('order.number')}</Th>
            <Th>{t('quote.customer')}</Th>
            <Th className="text-right">{t('quote.total')}</Th>
            <Th>{t('order.paymentStatus')}</Th>
            <Th>{t('order.fulfillmentStatus')}</Th>
            <Th>{t('activity.when')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-surface-sunken">
              <Td>
                <Link
                  href={`/orders/${row.id}`}
                  className="font-mono font-medium text-accent hover:underline"
                >
                  {row.orderNumber}
                </Link>
                <div className="font-mono text-xs text-ink-faint">{row.quotationNumber}</div>
              </Td>
              <Td>{row.customerName}</Td>
              <Td className="tabular text-right">
                {formatMoney({ amountMinor: row.grandTotalMinor, currency: row.currency })}
              </Td>
              <Td>
                <Badge tone={PAYMENT_TONE[row.paymentStatus]}>
                  {t(paymentStatusKey(row.paymentStatus))}
                </Badge>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={FULFILMENT_TONE[row.fulfillmentStatus]}>
                    {t(fulfilmentStatusKey(row.fulfillmentStatus))}
                  </Badge>
                  {row.status === 'CANCELLED' ? (
                    <Badge>{t(orderStatusKey(row.status))}</Badge>
                  ) : null}
                </div>
              </Td>
              <Td className="text-ink-muted whitespace-nowrap">
                {formatDate(row.createdAt, session.locale, session.timezone)}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {rows.length === 0 ? <EmptyState message={t('order.empty')} /> : null}
    </>
  );
}
