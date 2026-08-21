import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { deliveryQueue } from '@/modules/fulfillment';
import type { DeliveryStatus } from '@/modules/fulfillment';
import { formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

export const DELIVERY_TONE = {
  PENDING: 'neutral',
  ASSIGNED: 'accent',
  DISPATCHED: 'caution',
  DELIVERED: 'positive',
  FAILED: 'critical',
  CANCELLED: 'neutral',
} as const;

export function deliveryStatusKey(status: string): MessageKey {
  return `delStatus.${status.toLowerCase()}` as MessageKey;
}

const FILTERS: readonly { label: MessageKey; statuses: readonly DeliveryStatus[] | null }[] = [
  { label: 'del.title', statuses: null },
  { label: 'delStatus.pending', statuses: ['PENDING'] },
  { label: 'delStatus.assigned', statuses: ['ASSIGNED'] },
  { label: 'delStatus.dispatched', statuses: ['DISPATCHED'] },
  { label: 'delStatus.delivered', statuses: ['DELIVERED'] },
  { label: 'delStatus.failed', statuses: ['FAILED'] },
];

export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requirePermission('read:delivery');
  const { status } = await searchParams;

  const selected = FILTERS.find(
    (filter) => filter.statuses?.[0] === status?.toUpperCase(),
  );

  const rows = await withTenant(session.organizationId, (tx) =>
    deliveryQueue(tx, selected?.statuses ? { statuses: selected.statuses } : {}),
  );

  return (
    <>
      <PageHeader title={t('del.title')} description={t('del.hint')} />

      <nav className="mb-4 -mx-1 flex gap-1 overflow-x-auto">
        {FILTERS.map((filter) => {
          const value = filter.statuses?.[0];
          const active = value === status?.toUpperCase() || (!value && !status);
          return (
            <Link
              key={filter.label}
              href={value ? `/deliveries?status=${value}` : '/deliveries'}
              className={`rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
                active
                  ? 'bg-surface-sunken text-ink'
                  : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
              }`}
            >
              {value ? t(filter.label) : 'All'}
            </Link>
          );
        })}
      </nav>

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('del.number')}</Th>
            <Th>{t('order.number')}</Th>
            <Th>{t('quote.customer')}</Th>
            <Th>{t('del.destination')}</Th>
            <Th>{t('del.driver')}</Th>
            <Th>{t('del.vehicle')}</Th>
            <Th>{t('quote.status')}</Th>
            <Th>{t('del.dispatchedAt')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid="delivery-row" data-order={row.orderNumber}>
              <Td>
                <Link
                  href={`/deliveries/${row.id}`}
                  className="font-mono text-accent hover:underline"
                >
                  {row.deliveryNumber}
                </Link>
              </Td>
              <Td className="font-mono text-xs">{row.orderNumber}</Td>
              <Td>
                <div>{row.customerName}</div>
                {row.customerPhone ? (
                  <div className="text-xs text-ink-faint">{row.customerPhone}</div>
                ) : null}
              </Td>
              <Td className="max-w-xs text-ink-muted">{row.destination}</Td>
              <Td className="text-ink-muted">{row.driverName ?? '—'}</Td>
              <Td className="font-mono text-xs text-ink-muted">{row.vehicleReference ?? '—'}</Td>
              <Td>
                <Badge tone={DELIVERY_TONE[row.status]}>{t(deliveryStatusKey(row.status))}</Badge>
              </Td>
              <Td className="text-ink-muted whitespace-nowrap">
                {row.dispatchedAt
                  ? formatDateTime(row.dispatchedAt, session.locale, session.timezone)
                  : '—'}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {rows.length === 0 ? <EmptyState message={t('del.empty')} /> : null}
    </>
  );
}
