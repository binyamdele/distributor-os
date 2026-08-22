import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { getReturn } from '@/modules/inventory';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { formatDateTime, t } from '@/platform/i18n';
import { Badge, Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { RETURN_TONE, returnStatusKey } from '../page';
import {
  CompleteReturnForm,
  InspectReturnForm,
  ReceiveReturnForm,
  WithdrawReturnForm,
} from '../../exceptions/exception-forms';

/**
 * One return, as the person unloading the lorry sees it.
 *
 * Quantities and conditions. No prices, no order total, no payment evidence — the same rule as
 * the warehouse floor in Phase 6, for the same reason.
 *
 * The accounting strip is the point of the screen: eighty went out, and eighty are accounted
 * for as sellable, damaged, not returned, or still with the customer. A quantity that vanishes
 * from that row is a quantity nobody can be asked about later.
 */
export default async function ReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('read:inventory-exception');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const found = await getReturn(tx, id);
    if (!found.ok) return null;
    return {
      entry: found.value,
      history: can(session.role, 'read:audit') ? await auditTrailFor(tx, 'return', id) : [],
    };
  });

  if (!data) notFound();
  const { entry, history } = data;

  const withCustomer =
    entry.totals.dispatched -
    entry.totals.restockable -
    entry.totals.damaged -
    entry.totals.missing;

  return (
    <>
      <PageHeader
        title={entry.returnNumber}
        description={`${entry.customerName} · ${entry.orderNumber}`}
        action={<Badge tone={RETURN_TONE[entry.status]}>{t(returnStatusKey(entry.status))}</Badge>}
      />

      {entry.status === 'COMPLETED' ? (
        <Card className="mb-6 border-positive/30 bg-positive-soft" data-testid="return-completed">
          <p className="text-sm text-ink">
            {t('ret.completed')}{' '}
            {entry.completedAt
              ? formatDateTime(entry.completedAt, session.locale, session.timezone)
              : ''}
          </p>
          <p className="mt-1 text-xs text-ink-muted">{t('ret.noRefund')}</p>
        </Card>
      ) : null}

      {/* --- what went out and what came back -------------------------------- */}
      <section className="mb-6">
        <TableWrap>
          <thead>
            <tr>
              <Th>Product</Th>
              <Th className="text-right">{t('ret.dispatched')}</Th>
              <Th className="text-right">{t('ret.expected')}</Th>
              <Th className="text-right">{t('ret.received')}</Th>
              <Th className="text-right">{t('ret.restockable')}</Th>
              <Th className="text-right">{t('ret.damaged')}</Th>
              <Th className="text-right">{t('ret.missing')}</Th>
            </tr>
          </thead>
          <tbody>
            {entry.items.map((item) => (
              <tr key={item.id} data-testid="return-item" data-sku={item.sku}>
                <Td>
                  <div className="font-medium text-ink">{item.description}</div>
                  <div className="font-mono text-xs text-ink-faint">{item.sku}</div>
                </Td>
                <Td className="tabular text-right">
                  {item.quantityDispatched.toLocaleString()} {item.unit}
                </Td>
                <Td className="tabular text-right text-ink-muted">
                  {item.quantityExpected.toLocaleString()}
                </Td>
                <Td className="tabular text-right">{item.quantityReceived.toLocaleString()}</Td>
                <Td className="tabular text-right font-medium text-positive">
                  {item.quantityRestockable.toLocaleString()}
                </Td>
                <Td className="tabular text-right text-critical">
                  {item.quantityDamaged.toLocaleString()}
                </Td>
                <Td className="tabular text-right text-ink-muted">
                  {item.quantityMissing.toLocaleString()}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>

        <Card className="mt-3" data-testid="return-accounting">
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('ret.accounting')}</h2>
          <div className="tabular flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              {t('ret.dispatched')}:{' '}
              <strong>{entry.totals.dispatched.toLocaleString()}</strong>
            </span>
            <span className="text-positive">
              {t('ret.restockable')}: {entry.totals.restockable.toLocaleString()}
            </span>
            <span className="text-critical">
              {t('ret.damaged')}: {entry.totals.damaged.toLocaleString()}
            </span>
            <span className="text-ink-muted">
              {t('ret.missing')}: {entry.totals.missing.toLocaleString()}
            </span>
            {withCustomer > 0 ? (
              <span className="text-ink-muted">Kept by customer: {withCustomer.toLocaleString()}</span>
            ) : null}
          </div>
        </Card>
      </section>

      {/* --- the legal action, and only that ---------------------------------- */}
      <section className="mb-6 space-y-4">
        {entry.status === 'EXPECTED' && can(session.role, 'receive:return') ? (
          <Card>
            <ReceiveReturnForm returnId={entry.id} />
          </Card>
        ) : null}

        {(entry.status === 'RECEIVED' || entry.status === 'INSPECTED') &&
        can(session.role, 'inspect:return') ? (
          <Card>
            <InspectReturnForm
              returnId={entry.id}
              lines={entry.items.map((item) => ({
                id: item.id,
                sku: item.sku,
                description: item.description,
                unit: item.unit,
                quantityDispatched: item.quantityDispatched,
                quantityExpected: item.quantityExpected,
                quantityReceived: item.quantityReceived,
                quantityRestockable: item.quantityRestockable,
                quantityDamaged: item.quantityDamaged,
              }))}
            />
          </Card>
        ) : null}

        {entry.status === 'INSPECTED' && can(session.role, 'complete:return') ? (
          <Card>
            <CompleteReturnForm returnId={entry.id} />
          </Card>
        ) : null}

        {entry.status !== 'COMPLETED' &&
        entry.status !== 'CANCELLED' &&
        can(session.role, 'create:return') ? (
          <Card>
            <WithdrawReturnForm returnId={entry.id} />
          </Card>
        ) : null}
      </section>

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="space-y-1.5 text-sm">
          <Row label={t('quote.customer')} value={entry.customerName} />
          <Row label={t('del.destination')} value={entry.destination} />
          <Row label="Reason" value={entry.returnReason.toLowerCase().replace(/_/g, ' ')} />
          {entry.note ? <p className="pt-1 text-ink-muted">{entry.note}</p> : null}
          <div className="flex gap-3 pt-1">
            <Link
              href={`/orders/${entry.orderId}`}
              className="font-mono text-sm text-accent hover:underline"
            >
              {entry.orderNumber}
            </Link>
            <Link
              href={`/deliveries/${entry.deliveryId}`}
              className="font-mono text-sm text-accent hover:underline"
            >
              {entry.deliveryNumber}
            </Link>
          </div>
        </Card>

        <Card className="space-y-1.5 text-sm">
          {entry.receivedAt ? (
            <Row
              label={t('retStatus.received')}
              value={formatDateTime(entry.receivedAt, session.locale, session.timezone)}
            />
          ) : null}
          {entry.inspectedAt ? (
            <Row
              label={t('retStatus.inspected')}
              value={formatDateTime(entry.inspectedAt, session.locale, session.timezone)}
            />
          ) : null}
          {entry.completedAt ? (
            <Row
              label={t('retStatus.completed')}
              value={formatDateTime(entry.completedAt, session.locale, session.timezone)}
            />
          ) : null}
        </Card>
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
              {history.map((event) => (
                <tr key={event.id}>
                  <Td className="font-mono text-xs">{event.action}</Td>
                  <Td className="text-ink-muted whitespace-nowrap">
                    {formatDateTime(event.createdAt, session.locale, session.timezone)}
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
