import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { getOrder } from '@/modules/orders';
import { orderBalance, paymentsForOrder } from '@/modules/payments';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { formatMoney } from '@/platform/money';
import { formatDate, formatDateTime, t } from '@/platform/i18n';
import { Badge, Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import {
  FULFILMENT_TONE,
  ORDER_STATUS_TONE,
  PAYMENT_TONE,
  fulfilmentStatusKey,
  orderStatusKey,
  paymentStatusKey,
} from '../page';
import { CancelOrderForm } from '../order-forms';
import { SubmitPaymentForm } from '../../payments/submit-form';
import { PAYMENT_STATE_TONE, methodKey, paymentStateKey } from '../../payments/page';

/**
 * The sales order screen.
 *
 * Two things it must say plainly, because getting either wrong costs a distributor real money:
 * that stock is held for this order, and that holding stock is *not* permission for the
 * warehouse to release it. A cash order waits for finance; that unlock is Phase 5's.
 */
export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('read:order');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const order = await getOrder(tx, id);
    if (!order.ok) return null;
    const balance = await orderBalance(tx, id);
    return {
      order: order.value,
      payments: await paymentsForOrder(tx, id),
      balance: balance.ok ? balance.value : null,
      history: can(session.role, 'read:audit') ? await auditTrailFor(tx, 'sales_order', id) : [],
    };
  });

  if (!data) notFound();
  const { order, payments, balance, history } = data;
  const fmt = (amountMinor: bigint) => formatMoney({ amountMinor, currency: order.currency });

  const activeReservations = order.reservations.filter(
    (reservation) => reservation.status === 'ACTIVE',
  );

  return (
    <>
      <PageHeader
        title={order.orderNumber}
        description={`${order.customer.companyName} · ${formatDate(
          order.createdAt,
          session.locale,
          session.timezone,
        )}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={ORDER_STATUS_TONE[order.status]}>{t(orderStatusKey(order.status))}</Badge>
            <Badge tone={PAYMENT_TONE[order.paymentStatus]}>
              {t(paymentStatusKey(order.paymentStatus))}
            </Badge>
            <Badge tone={FULFILMENT_TONE[order.fulfillmentStatus]}>
              {t(fulfilmentStatusKey(order.fulfillmentStatus))}
            </Badge>
          </div>
        }
      />

      {/* --- what happens next, stated rather than implied ------------------ */}
      {order.status === 'CANCELLED' ? (
        <Card className="mb-6">
          <p className="text-sm text-ink">{t('order.cancelled')}</p>
          {order.cancellationReason ? (
            <p className="mt-1 text-sm text-ink-muted">{order.cancellationReason}</p>
          ) : null}
        </Card>
      ) : order.paymentType === 'CASH' && order.fulfillmentStatus !== 'READY' ? (
        // Only while the money is still outstanding. Leaving this up on a settled order would
        // tell the warehouse to hold goods that have been paid for.
        <Card className="mb-6 border-caution/30 bg-caution-soft" data-testid="awaiting-payment">
          <p className="text-sm text-ink">{t('order.awaitingPayment')}</p>
          <p className="mt-1 text-xs text-ink-muted">{t('order.noWarehouseYet')}</p>
        </Card>
      ) : order.paymentType === 'CASH' ? (
        <Card className="mb-6 border-positive/30 bg-positive-soft" data-testid="payment-settled">
          <p className="text-sm text-ink">{t('order.cashSettled')}</p>
          <p className="mt-1 text-xs text-ink-muted">{t('order.noWarehouseYet')}</p>
        </Card>
      ) : (
        <Card className="mb-6 border-positive/30 bg-positive-soft">
          <p className="text-sm text-ink">{t('order.creditReady')}</p>
          <p className="mt-1 text-xs text-ink-muted">{t('order.noWarehouseYet')}</p>
        </Card>
      )}

      {/* --- the commercial snapshot ---------------------------------------- */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">{t('order.lines')}</h2>
        <TableWrap>
          <thead>
            <tr>
              <Th>Product</Th>
              <Th className="text-right">{t('quote.quantity')}</Th>
              <Th className="text-right">{t('order.reserved')}</Th>
              <Th className="text-right">{t('quote.discount')}</Th>
              <Th className="text-right">{t('quote.lineTotal')}</Th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line) => (
              <tr key={line.id} data-testid="order-line" data-sku={line.sku}>
                <Td>
                  <div className="font-medium text-ink">{line.description}</div>
                  <div className="font-mono text-xs text-ink-faint">{line.sku}</div>
                </Td>
                <Td className="tabular text-right">
                  {line.quantity.toLocaleString()} {line.unit}
                </Td>
                <Td className="tabular text-right">
                  {line.reservedQuantity.toLocaleString()}
                </Td>
                <Td className="tabular text-right">
                  {line.discountBp > 0 ? `${(line.discountBp / 100).toFixed(2)}%` : '—'}
                </Td>
                <Td className="tabular text-right font-medium">{fmt(line.lineTotalMinor)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </section>

      <section className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="space-y-1.5 text-sm">
          <Row label={t('quote.subtotal')} value={fmt(order.subtotalMinor)} />
          {order.discountTotalMinor > 0n ? (
            <Row label={t('quote.discountTotal')} value={`− ${fmt(order.discountTotalMinor)}`} />
          ) : null}
          {order.deliveryFeeMinor > 0n ? (
            <Row label={t('quote.deliveryFee')} value={fmt(order.deliveryFeeMinor)} />
          ) : null}
          <Row label={t('quote.taxTotal')} value={fmt(order.taxTotalMinor)} />
          <div className="mt-2 flex justify-between border-t border-border-subtle pt-2 text-base font-semibold">
            <span>{t('quote.grandTotal')}</span>
            <span className="tabular" data-testid="order-total">
              {fmt(order.grandTotalMinor)}
            </span>
          </div>
        </Card>

        <Card className="space-y-2 text-sm">
          <Row
            label={t('quote.paymentTerms')}
            value={
              order.paymentType === 'CASH'
                ? t('quote.cash')
                : `Credit — ${order.paymentTermsDays} days`
            }
          />
          {order.paymentDueDate ? (
            <Row
              label={t('order.paymentDue')}
              value={formatDate(order.paymentDueDate, session.locale, session.timezone)}
            />
          ) : null}
          {order.customer.phone ? (
            <Row label={t('followUp.contact')} value={order.customer.phone} />
          ) : null}
          {order.deliveryRequired ? (
            <Row label={t('order.deliveryAddress')} value={order.deliveryAddressSnapshot ?? '—'} />
          ) : null}
          <div className="pt-1">
            <Link
              href={`/quotations/${order.quotation.id}`}
              className="font-mono text-sm text-accent hover:underline"
            >
              {t('order.sourceQuotation')} {order.quotation.quotationNumber}
            </Link>
          </div>
        </Card>
      </section>

      {/* --- reservations, so "who is holding this stock" is answerable ------ */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">
          {t('order.reservations')}{' '}
          <span className="font-normal text-ink-faint">
            ({activeReservations.length} active)
          </span>
        </h2>
        <TableWrap>
          <thead>
            <tr>
              <Th>Product</Th>
              <Th className="text-right">{t('quote.quantity')}</Th>
              <Th>Status</Th>
              <Th>Released</Th>
            </tr>
          </thead>
          <tbody>
            {order.reservations.map((reservation) => (
              <tr key={reservation.id}>
                <Td className="font-mono text-xs">{reservation.sku}</Td>
                <Td className="tabular text-right">{reservation.quantity.toLocaleString()}</Td>
                <Td>
                  <Badge tone={reservation.status === 'ACTIVE' ? 'positive' : 'neutral'}>
                    {reservation.status}
                  </Badge>
                </Td>
                <Td className="text-ink-muted whitespace-nowrap">
                  {reservation.releasedAt
                    ? formatDateTime(reservation.releasedAt, session.locale, session.timezone)
                    : '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </section>

      {/* --- money: what has been claimed, what has been confirmed ---------- */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">{t('pay.history')}</h2>

        {balance ? (
          <Card className="mb-3 grid gap-1.5 text-sm sm:grid-cols-3">
            <Row label={t('pay.confirmed')} value={fmt(balance.confirmedMinor)} />
            <Row label={t('pay.outstanding')} value={fmt(balance.outstandingMinor)} />
            {balance.overpaidMinor > 0n ? (
              <Row label={t('pay.overpaid')} value={fmt(balance.overpaidMinor)} />
            ) : null}
          </Card>
        ) : null}

        {payments.length > 0 ? (
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('pay.method')}</Th>
                <Th>{t('pay.reference')}</Th>
                <Th className="text-right">{t('pay.claimed')}</Th>
                <Th className="text-right">{t('pay.confirmed')}</Th>
                <Th>{t('quote.status')}</Th>
                <Th>{t('pay.submittedAt')}</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id} data-testid="order-payment">
                  <Td>{t(methodKey(payment.method))}</Td>
                  <Td className="font-mono text-xs">{payment.transactionReference ?? '—'}</Td>
                  <Td className="tabular text-right">{fmt(payment.amountClaimedMinor)}</Td>
                  <Td className="tabular text-right">
                    {payment.amountConfirmedMinor === null
                      ? '—'
                      : fmt(payment.amountConfirmedMinor)}
                  </Td>
                  <Td>
                    {can(session.role, 'review:payment') ? (
                      <Link href={`/payments/${payment.id}`}>
                        <Badge tone={PAYMENT_STATE_TONE[payment.status]}>
                          {t(paymentStateKey(payment.status))}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge tone={PAYMENT_STATE_TONE[payment.status]}>
                        {t(paymentStateKey(payment.status))}
                      </Badge>
                    )}
                  </Td>
                  <Td className="text-ink-muted whitespace-nowrap">
                    {formatDateTime(payment.submittedAt, session.locale, session.timezone)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        ) : (
          <Card>
            <p className="text-sm text-ink-muted">{t('pay.noPayments')}</p>
          </Card>
        )}

        {order.status === 'OPEN' &&
        can(session.role, 'submit:payment-evidence') &&
        balance &&
        balance.outstandingMinor > 0n ? (
          <Card className="mt-3">
            <h3 className="mb-3 text-sm font-semibold text-ink">{t('pay.submitTitle')}</h3>
            <SubmitPaymentForm
              salesOrderId={order.id}
              outstanding={decimalString(balance.outstandingMinor)}
            />
          </Card>
        ) : null}
      </section>

      {order.status === 'OPEN' && can(session.role, 'cancel:order') ? (
        <section className="mb-6">
          <Card>
            <CancelOrderForm orderId={order.id} />
            <p className="mt-2 text-xs text-ink-faint">
              Cancelling releases the stock held for this order. The quotation is left as it is —
              it remains the record of what the customer accepted.
            </p>
          </Card>
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

/** Minor units to the decimal string the payment form pre-fills. */
function decimalString(minor: bigint): string {
  const absolute = minor < 0n ? -minor : minor;
  return `${minor < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-muted">{label}</span>
      <span className="tabular text-ink">{value}</span>
    </div>
  );
}
