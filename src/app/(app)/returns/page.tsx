import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { returnQueue } from '@/modules/inventory';
import { formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

export const RETURN_TONE = {
  EXPECTED: 'caution',
  RECEIVED: 'accent',
  INSPECTED: 'accent',
  COMPLETED: 'positive',
  CANCELLED: 'neutral',
} as const;

export function returnStatusKey(status: string): MessageKey {
  return `retStatus.${status.toLowerCase()}` as MessageKey;
}

/**
 * Goods on their way back.
 *
 * Deliberately free of money: a person processing a physical return needs a SKU, a unit and
 * three quantities. The order total and the payment position are not theirs to see, and they
 * are not on the query rather than merely hidden here.
 */
export default async function ReturnsPage() {
  const session = await requirePermission('read:inventory-exception');

  const rows = await withTenant(session.organizationId, (tx) =>
    returnQueue(tx, { statuses: ['EXPECTED', 'RECEIVED', 'INSPECTED', 'COMPLETED'] }),
  );

  return (
    <>
      <PageHeader title={t('ret.title')} description={t('ret.hint')} />

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('ret.number')}</Th>
            <Th>{t('del.number')}</Th>
            <Th>{t('order.number')}</Th>
            <Th>{t('quote.customer')}</Th>
            <Th className="text-right">{t('wh.lines')}</Th>
            <Th>{t('quote.status')}</Th>
            <Th>{t('activity.when')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid="return-row" data-order={row.orderNumber}>
              <Td>
                <Link href={`/returns/${row.id}`} className="font-mono text-accent hover:underline">
                  {row.returnNumber}
                </Link>
              </Td>
              <Td className="font-mono text-xs">
                <Link href={`/deliveries/${row.deliveryId}`} className="hover:underline">
                  {row.deliveryNumber}
                </Link>
              </Td>
              <Td className="font-mono text-xs">{row.orderNumber}</Td>
              <Td>{row.customerName}</Td>
              <Td className="tabular text-right">{row.lineCount}</Td>
              <Td>
                <Badge tone={RETURN_TONE[row.status]}>{t(returnStatusKey(row.status))}</Badge>
              </Td>
              <Td className="text-ink-muted whitespace-nowrap">
                {formatDateTime(row.createdAt, session.locale, session.timezone)}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {rows.length === 0 ? <EmptyState message={t('ret.empty')} /> : null}
      <p className="mt-3 text-xs text-ink-faint">{t('ret.noRefund')}</p>
    </>
  );
}
