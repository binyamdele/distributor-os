import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { getDelivery } from '@/modules/fulfillment';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { DELIVERY_TONE, deliveryStatusKey } from '../page';
import {
  AssignForm,
  CompleteDeliveryForm,
  DispatchForm,
  FailDeliveryForm,
} from '../delivery-forms';

/**
 * One delivery run.
 *
 * Everything customer-facing here is the snapshot taken when the goods left the warehouse, not
 * the customer's current record. If someone updates a phone number tomorrow, what this page
 * showed today does not change — which is the only reason a delivery history is worth keeping.
 */
export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('read:delivery');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const delivery = await getDelivery(tx, id);
    if (!delivery.ok) return null;
    return {
      delivery: delivery.value,
      history: can(session.role, 'read:audit') ? await auditTrailFor(tx, 'delivery', id) : [],
    };
  });

  if (!data) notFound();
  const { delivery, history } = data;

  const live = delivery.status === 'PENDING' || delivery.status === 'ASSIGNED';

  return (
    <>
      <PageHeader
        title={delivery.deliveryNumber}
        description={`${delivery.customerName} · ${delivery.orderNumber}`}
        action={
          <Badge tone={DELIVERY_TONE[delivery.status]}>
            {t(deliveryStatusKey(delivery.status))}
          </Badge>
        }
      />

      {delivery.status === 'FAILED' ? (
        <Card className="mb-6 border-critical/30 bg-critical-soft" data-testid="delivery-failed">
          <p className="text-sm text-ink">
            {delivery.failureReason
              ? t(`fail.${delivery.failureReason}` as MessageKey)
              : t('fail.OTHER')}
            {delivery.failureNote ? ` — ${delivery.failureNote}` : ''}
          </p>
          {/* The absence of a restock is the thing someone will look for. State it. */}
          <p className="mt-2 text-xs text-ink-muted">{t('del.failedNoRestock')}</p>
        </Card>
      ) : null}

      {delivery.status === 'DELIVERED' ? (
        <Card className="mb-6 border-positive/30 bg-positive-soft" data-testid="delivery-delivered">
          <p className="text-sm text-ink">
            {t('del.deliveredAt')}{' '}
            {delivery.deliveredAt
              ? formatDateTime(delivery.deliveredAt, session.locale, session.timezone)
              : ''}
            {delivery.deliveryNote ? ` — ${delivery.deliveryNote}` : ''}
          </p>
          <p className="mt-2 text-xs text-ink-muted">{t('del.notProof')}</p>
        </Card>
      ) : null}

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="space-y-1.5 text-sm">
          <Row label={t('quote.customer')} value={delivery.customerName} />
          {delivery.customerPhone ? (
            <Row label={t('customer.phone')} value={delivery.customerPhone} />
          ) : null}
          <Row label={t('del.destination')} value={delivery.destination} />
          <div className="pt-1">
            <Link
              href={`/orders/${delivery.orderId}`}
              className="font-mono text-sm text-accent hover:underline"
            >
              {delivery.orderNumber}
            </Link>
          </div>
        </Card>

        <Card className="space-y-1.5 text-sm">
          <Row label={t('del.driver')} value={delivery.driverName ?? '—'} />
          <Row label={t('del.driverPhone')} value={delivery.driverPhone ?? '—'} />
          <Row label={t('del.vehicle')} value={delivery.vehicleReference ?? '—'} />
          {delivery.dispatchedAt ? (
            <Row
              label={t('del.dispatchedAt')}
              value={formatDateTime(delivery.dispatchedAt, session.locale, session.timezone)}
            />
          ) : null}
          {delivery.failedAt ? (
            <Row
              label={t('del.failedAt')}
              value={formatDateTime(delivery.failedAt, session.locale, session.timezone)}
            />
          ) : null}
        </Card>
      </section>

      <section className="mb-6 space-y-4">
        {live && can(session.role, 'assign:delivery') ? (
          <Card>
            <AssignForm
              deliveryId={delivery.id}
              defaults={{
                driverName: delivery.driverName ?? '',
                driverPhone: delivery.driverPhone ?? '',
                vehicleReference: delivery.vehicleReference ?? '',
              }}
            />
          </Card>
        ) : null}

        {live && can(session.role, 'dispatch:delivery') ? (
          <Card>
            <DispatchForm deliveryId={delivery.id} />
          </Card>
        ) : null}

        {delivery.status === 'DISPATCHED' && can(session.role, 'complete:delivery') ? (
          <Card>
            <CompleteDeliveryForm deliveryId={delivery.id} />
          </Card>
        ) : null}

        {delivery.status === 'DISPATCHED' && can(session.role, 'fail:delivery') ? (
          <Card>
            <FailDeliveryForm deliveryId={delivery.id} />
          </Card>
        ) : null}
      </section>

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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}
