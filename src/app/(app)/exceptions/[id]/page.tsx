import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { getDiscrepancy } from '@/modules/inventory';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { formatDateTime, t } from '@/platform/i18n';
import { Badge, Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { DISCREPANCY_TONE, discrepancyStatusKey } from '../page';
import {
  ReconcileForm,
  ReduceReservationForm,
  ReviewForm,
  WithdrawDiscrepancyForm,
} from '../exception-forms';

/**
 * One discrepancy, and the decision it is waiting for.
 *
 * The two figures sit side by side — what the system claimed when somebody disagreed, and what
 * they counted — because the gap between them is the whole subject. When the count cannot cover
 * what is committed, the affected orders are listed unranked and unsorted by anything
 * meaningful: choosing whose cement does not arrive is a conversation, and a screen that
 * suggested an answer would be making the decision while appearing to display information.
 */
export default async function DiscrepancyPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('read:inventory-exception');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const found = await getDiscrepancy(tx, id);
    if (!found.ok) return null;
    return {
      discrepancy: found.value,
      history: can(session.role, 'read:audit')
        ? await auditTrailFor(tx, 'inventory_discrepancy', id)
        : [],
    };
  });

  if (!data) notFound();
  const { discrepancy, history } = data;

  const live = discrepancy.status === 'OPEN' || discrepancy.status === 'UNDER_REVIEW';
  const shortfall = discrepancy.reservationShortfall ?? 0;

  return (
    <>
      <PageHeader
        title={discrepancy.discrepancyNumber}
        description={`${discrepancy.description} · ${discrepancy.sku}`}
        action={
          <Badge tone={DISCREPANCY_TONE[discrepancy.status]}>
            {t(discrepancyStatusKey(discrepancy.status))}
          </Badge>
        }
      />

      {discrepancy.status === 'RESOLVED' ? (
        <Card className="mb-6 border-positive/30 bg-positive-soft" data-testid="resolved-notice">
          <p className="text-sm text-ink">
            {discrepancy.resolutionType === 'STOCK_RECONCILED'
              ? t('exc.resolvedReconciled')
              : t('exc.resolvedNoChange')}
          </p>
          {discrepancy.resolutionNote ? (
            <p className="mt-1 text-sm text-ink-muted">{discrepancy.resolutionNote}</p>
          ) : null}
        </Card>
      ) : null}

      {/* --- the disagreement, in figures ------------------------------------ */}
      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="space-y-1.5 text-sm">
          <Row label={t('exc.systemOnHand')} value={discrepancy.systemOnHand.toLocaleString()} />
          <Row label={t('exc.reserved')} value={discrepancy.systemReserved.toLocaleString()} />
          <Row
            label={t('exc.counted')}
            value={`${discrepancy.physicalCount.toLocaleString()} ${discrepancy.unit}`}
          />
          <div className="flex justify-between gap-4 border-t border-border-subtle pt-2 font-semibold">
            <span>{t('exc.variance')}</span>
            <span
              className={`tabular ${discrepancy.variance < 0 ? 'text-critical' : 'text-positive'}`}
              data-testid="variance"
            >
              {discrepancy.variance > 0 ? '+' : ''}
              {discrepancy.variance.toLocaleString()}
            </span>
          </div>
        </Card>

        <Card className="space-y-1.5 text-sm">
          {discrepancy.orderNumber ? (
            <Row label={t('order.number')} value={discrepancy.orderNumber} />
          ) : null}
          {discrepancy.taskNumber ? (
            <Row label={t('wh.task')} value={discrepancy.taskNumber} />
          ) : null}
          <Row label={t('exc.reportedBy')} value={discrepancy.reportedByName ?? '—'} />
          <Row
            label={t('exc.age')}
            value={formatDateTime(discrepancy.reportedAt, session.locale, session.timezone)}
          />
          {/* Live figures, so a reviewer sees whether the ground has moved since the count. */}
          <Row label="Now on hand" value={discrepancy.currentOnHand.toLocaleString()} />
          <Row label="Now committed" value={discrepancy.currentReserved.toLocaleString()} />
          {discrepancy.reportNote ? (
            <p className="pt-1 text-ink-muted">{discrepancy.reportNote}</p>
          ) : null}
        </Card>
      </section>

      {/* --- the shortfall, when the yard cannot keep its promises ------------ */}
      {shortfall > 0 && live ? (
        <section className="mb-6">
          <Card className="border-critical/30 bg-critical-soft" data-testid="shortfall-notice">
            <h2 className="text-sm font-semibold text-critical">{t('exc.shortfall')}</h2>
            <p className="mt-1 text-sm text-ink">{t('exc.shortfallHint')}</p>
            <p className="tabular mt-2 text-sm text-ink-muted">
              {t('exc.counted')}: {discrepancy.physicalCount.toLocaleString()} ·{' '}
              {t('exc.reserved')}: {discrepancy.currentReserved.toLocaleString()} ·{' '}
              <span className="text-critical">−{shortfall.toLocaleString()}</span>
            </p>
          </Card>
        </section>
      ) : null}

      {/* --- who is holding this stock --------------------------------------- */}
      {live && discrepancy.affectedOrders.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-1 text-sm font-semibold text-ink">{t('exc.affectedOrders')}</h2>
          <p className="mb-3 text-xs text-ink-faint">{t('exc.affectedHint')}</p>
          <div className="space-y-2">
            {discrepancy.affectedOrders.map((order) => (
              <Card key={order.reservationId} data-testid="affected-order" data-order={order.orderNumber}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/orders/${order.salesOrderId}`}
                      className="font-mono text-sm text-accent hover:underline"
                    >
                      {order.orderNumber}
                    </Link>
                    <div className="text-sm text-ink-muted">{order.customerName}</div>
                  </div>
                  <div className="tabular text-sm text-ink-muted">
                    {t('exc.reserved.short')}: {order.reservedQuantity.toLocaleString()} ·{' '}
                    {t('exc.required')}: {order.requiredQuantity.toLocaleString()} ·{' '}
                    {formatDateTime(order.reservedSince, session.locale, session.timezone)}
                  </div>
                </div>
                {can(session.role, 'resolve:reservation-shortfall') ? (
                  <ReduceReservationForm
                    discrepancyId={discrepancy.id}
                    reservationId={order.reservationId}
                    currentQuantity={order.reservedQuantity}
                  />
                ) : null}
              </Card>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-faint">{t('exc.orderUntouched')}</p>
        </section>
      ) : null}

      {/* --- the legal actions, and only those ------------------------------- */}
      {live ? (
        <section className="mb-6 space-y-4">
          {discrepancy.status === 'OPEN' && can(session.role, 'review:inventory-discrepancy') ? (
            <Card>
              <ReviewForm discrepancyId={discrepancy.id} />
            </Card>
          ) : null}

          {can(session.role, 'resolve:inventory-discrepancy') ? (
            <Card>
              <ReconcileForm discrepancyId={discrepancy.id} />
            </Card>
          ) : null}

          {can(session.role, 'resolve:inventory-discrepancy') ? (
            <Card>
              <WithdrawDiscrepancyForm discrepancyId={discrepancy.id} />
            </Card>
          ) : null}
        </section>
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-muted">{label}</span>
      <span className="tabular text-ink">{value}</span>
    </div>
  );
}
