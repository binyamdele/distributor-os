import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { ordersAwaitingWarehouse, warehouseQueue } from '@/modules/fulfillment';
import { can } from '@/platform/rbac';
import { formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, Card, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { CreateTaskForm } from './warehouse-forms';

export const TASK_TONE = {
  PENDING: 'neutral',
  IN_PROGRESS: 'accent',
  PREPARED: 'caution',
  COMPLETED: 'positive',
  CANCELLED: 'neutral',
} as const;

export function taskStatusKey(status: string): MessageKey {
  return `whStatus.${status.toLowerCase()}` as MessageKey;
}

/**
 * The warehouse floor.
 *
 * Quantities, SKUs and units. No line prices, no order total, no payment detail — a picker
 * needs to know what to put on a trolley, and passing the financial columns through "because
 * they are on the row anyway" is how a customer's commercial terms end up on a screen in a yard.
 *
 * The one money-adjacent thing shown is a boolean: this order cleared its gate. That is what
 * makes it pickable, and it is all the warehouse needs to know about it.
 */
export default async function WarehousePage() {
  const session = await requirePermission('read:warehouse-task');

  const { queue, awaiting } = await withTenant(session.organizationId, async (tx) => ({
    queue: await warehouseQueue(tx),
    awaiting: can(session.role, 'create:warehouse-task')
      ? await ordersAwaitingWarehouse(tx)
      : [],
  }));

  return (
    <>
      <PageHeader title={t('wh.title')} description={t('wh.hint')} />

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('wh.task')}</Th>
            <Th>{t('order.number')}</Th>
            <Th>{t('quote.customer')}</Th>
            <Th className="text-right">{t('wh.lines')}</Th>
            <Th className="text-right">{t('wh.units')}</Th>
            <Th>{t('quote.status')}</Th>
            <Th>{t('wh.assignedTo')}</Th>
            <Th>{t('order.deliveryRequired')}</Th>
          </tr>
        </thead>
        <tbody>
          {queue.map((row) => (
            <tr key={row.id} data-testid="warehouse-row" data-order={row.orderNumber}>
              <Td>
                <Link
                  href={`/warehouse/${row.id}`}
                  className="font-mono text-accent hover:underline"
                >
                  {row.taskNumber}
                </Link>
              </Td>
              <Td className="font-mono text-xs">{row.orderNumber}</Td>
              <Td>{row.customerName}</Td>
              <Td className="tabular text-right">
                {row.preparedCount}/{row.lineCount}
              </Td>
              <Td className="tabular text-right">{row.totalUnits.toLocaleString()}</Td>
              <Td>
                <Badge tone={TASK_TONE[row.status]}>{t(taskStatusKey(row.status))}</Badge>
              </Td>
              <Td className="text-ink-muted">{row.assignedUserName ?? '—'}</Td>
              <Td className="text-ink-muted">{row.deliveryRequired ? t('wh.delivery') : '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {queue.length === 0 ? <EmptyState message={t('wh.empty')} /> : null}

      <p className="mt-3 text-xs text-ink-faint">{t('wh.noFinancials')}</p>

      {awaiting.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-1 text-sm font-semibold text-ink">{t('wh.awaiting')}</h2>
          <p className="mb-3 text-xs text-ink-faint">{t('wh.awaitingHint')}</p>
          <div className="space-y-2">
            {awaiting.map((order) => (
              <Card
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-3"
                data-testid="awaiting-order"
                data-order={order.orderNumber}
              >
                <div className="min-w-0">
                  <div className="font-mono text-sm text-ink">{order.orderNumber}</div>
                  <div className="text-sm text-ink-muted">
                    {order.customerName} · {order.lineCount} {t('wh.lines').toLowerCase()}
                    {order.deliveryRequired ? ` · ${t('wh.delivery').toLowerCase()}` : ''}
                  </div>
                  <div className="text-xs text-ink-faint">
                    {formatDateTime(order.readySince, session.locale, session.timezone)}
                  </div>
                </div>
                <CreateTaskForm salesOrderId={order.id} />
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
