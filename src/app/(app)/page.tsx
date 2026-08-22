import Link from 'next/link';
import { requireSession } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { getDashboardSnapshot, narrateBrief } from '@/modules/reporting';
import type { AttentionItem, AttentionSeverity, DashboardSnapshot } from '@/modules/reporting';
import { formatMoney } from '@/platform/money';
import { formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { config } from '@/platform/config';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';

/**
 * The owner dashboard.
 *
 * Four questions, in the order somebody actually asks them: what happened today, what needs
 * attention, where is money stuck, where is fulfilment stuck. One `getDashboardSnapshot` call
 * supplies all of it — components do not fetch, so two cards cannot disagree and the page cannot
 * quietly become forty round trips.
 *
 * A section the role may not see is absent from the snapshot, not merely hidden here. That is
 * the difference between a permission and a rendering preference.
 */
export default async function DashboardPage() {
  const session = await requireSession();

  const snapshot = await withTenant(session.organizationId, (tx) =>
    getDashboardSnapshot(tx, {
      timezone: session.timezone,
      currency: session.currency,
      role: session.role,
      attentionLimit: 12,
    }),
  );

  // Narration is on only when a real provider is configured. With the mock, the deterministic
  // brief is both what the owner would get in production during an outage and what is honest to
  // show — labelling mock prose "AI-assisted" would be a small lie on a page about trust.
  const narrated = await narrateBrief(snapshot, {
    useAi: config().AI_PROVIDER === 'anthropic',
  });

  const money = (minor: bigint) => formatMoney({ amountMinor: minor, currency: snapshot.currency });

  return (
    <>
      <PageHeader
        title={`${t('dashboard.welcome')}, ${session.fullName.split(' ')[0]}`}
        description={`${session.organizationName} · ${t('dash.asOf')} ${formatDateTime(
          snapshot.asOf,
          session.locale,
          session.timezone,
        )} (${snapshot.timezone})`}
      />

      {/* --- the four figures worth seeing first ---------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="kpi-row">
        {snapshot.sales ? (
          <Kpi
            label={t('dash.ordersToday')}
            value={String(snapshot.sales.ordersCreated)}
            sub={money(snapshot.sales.orderValueTodayMinor)}
            href="/orders"
            testId="kpi-orders"
          />
        ) : null}

        {snapshot.sales ? (
          <Kpi
            label={t('dash.acceptedValue')}
            value={money(snapshot.sales.acceptedValueTodayMinor)}
            sub={`${snapshot.sales.quotationsAccepted} ${t('dash.quotesAccepted').toLowerCase()}`}
            href="/quotations"
            testId="kpi-accepted"
          />
        ) : null}

        {snapshot.cash ? (
          <Kpi
            label={t('dash.paymentsToday')}
            value={money(snapshot.cash.paymentsConfirmedTodayMinor)}
            sub={`${snapshot.cash.paymentsConfirmedToday} confirmed`}
            href="/payments"
            testId="kpi-payments"
          />
        ) : null}

        {snapshot.cash ? (
          <Kpi
            label={t('dash.overdue')}
            value={money(snapshot.cash.overdueReceivablesMinor)}
            sub={`${snapshot.cash.overdueCount} ${snapshot.cash.overdueCount === 1 ? 'order' : 'orders'}`}
            href="/receivables"
            tone={snapshot.cash.overdueReceivablesMinor > 0n ? 'critical' : 'neutral'}
            testId="kpi-overdue"
          />
        ) : null}
      </div>

      {/* --- what to do about it -------------------------------------------- */}
      <section className="mt-8">
        <h2 className="mb-1 text-sm font-semibold text-ink">{t('dash.attention')}</h2>
        <p className="mb-3 text-xs text-ink-faint">{t('dash.attentionHint')}</p>

        {snapshot.attention.length === 0 ? (
          <EmptyState message={t('dash.attentionEmpty')} />
        ) : (
          <div className="space-y-2">
            {snapshot.attention.map((item) => (
              <AttentionRow
                key={`${item.kind}-${item.entityId}`}
                item={item}
                currency={snapshot.currency}
              />
            ))}
          </div>
        )}
      </section>

      {/* --- the daily summary ---------------------------------------------- */}
      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">
          {narrated.brief.source === 'AI' ? t('dash.briefAi') : t('dash.brief')}
        </h2>
        <Card data-testid="daily-brief" data-source={narrated.brief.source}>
          <p className="text-sm leading-relaxed text-ink">{narrated.brief.summary}</p>

          {narrated.brief.highlights.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm text-ink-muted">
              {narrated.brief.highlights.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}

          {narrated.brief.attention.length > 0 ? (
            <ul className="mt-3 space-y-1 border-t border-border-subtle pt-3 text-sm text-ink">
              {narrated.brief.attention.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}

          {/*
           * Labelled for what it is. Claiming an AI-assisted summary while showing the
           * deterministic fallback would be a small lie on the one page whose whole value is
           * that its numbers can be trusted.
           */}
          <p className="mt-3 text-xs text-ink-faint">
            {narrated.brief.source === 'AI' ? t('dash.briefAiNote') : t('dash.briefPlainNote')}
          </p>
        </Card>
      </section>

      {/* --- one chart, because one is enough -------------------------------- */}
      {snapshot.series.length > 0 && (snapshot.sales || snapshot.cash) ? (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('dash.chart')}</h2>
          <Card>
            <SevenDayBars snapshot={snapshot} />
          </Card>
        </section>
      ) : null}

      {/* --- the compact sections -------------------------------------------- */}
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {snapshot.sales && snapshot.pipeline ? (
          <Panel title={t('dash.pipeline')} href="/quotations" testId="panel-pipeline">
            <Row label={t('dash.quotesCreated')} value={snapshot.sales.quotationsCreated} />
            <Row label={t('dash.quotesAccepted')} value={snapshot.sales.quotationsAccepted} />
            <Row label={t('dash.quotesRejected')} value={snapshot.sales.quotationsRejected} />
            <Row
              label={t('dash.acceptanceRate')}
              value={
                snapshot.sales.acceptanceRate === null
                  ? t('dash.noRate')
                  : `${Math.round(snapshot.sales.acceptanceRate * 100)}%`
              }
              hint={t('dash.acceptanceRateHint')}
            />
            <Row
              label={t('dash.awaitingReview')}
              value={snapshot.pipeline.inquiriesAwaitingReview}
            />
            <Row
              label={t('dash.awaitingApproval')}
              value={snapshot.pipeline.quotationsAwaitingApproval}
            />
            <Row
              label={t('dash.sentAwaiting')}
              value={snapshot.pipeline.quotationsSentAwaitingOutcome}
            />
            <Row
              label={t('dash.followUpsOverdue')}
              value={snapshot.pipeline.followUpsOverdue}
              tone={snapshot.pipeline.followUpsOverdue > 0 ? 'caution' : 'neutral'}
            />
            {snapshot.sales.largestOrder ? (
              <div className="mt-2 border-t border-border-subtle pt-2 text-sm">
                <div className="text-ink-muted">{t('dash.largestOrder')}</div>
                <Link
                  href={`/orders/${snapshot.sales.largestOrder.orderId}`}
                  className="text-accent hover:underline"
                  data-testid="largest-order"
                >
                  {snapshot.sales.largestOrder.orderNumber} ·{' '}
                  {snapshot.sales.largestOrder.customerName} ·{' '}
                  {money(snapshot.sales.largestOrder.valueMinor)}
                </Link>
              </div>
            ) : null}
          </Panel>
        ) : null}

        {snapshot.cash ? (
          <Panel title={t('dash.receivables')} href="/receivables" testId="panel-receivables">
            <Row
              label={t('dash.outstanding')}
              value={money(snapshot.cash.outstandingReceivablesMinor)}
            />
            <Row
              label={t('dash.overdue')}
              value={money(snapshot.cash.overdueReceivablesMinor)}
              tone={snapshot.cash.overdueReceivablesMinor > 0n ? 'critical' : 'neutral'}
            />
            <Row label={t('dash.dueToday')} value={money(snapshot.cash.dueTodayMinor)} />
            <Row label={t('dash.dueSoon')} value={money(snapshot.cash.dueSoonMinor)} />
            <Row label={t('dash.debtors')} value={snapshot.cash.debtorCount} />
            <Row
              label={t('dash.awaitingFinance')}
              value={snapshot.cash.paymentsAwaitingReview}
              tone={snapshot.cash.paymentsAwaitingReview > 0 ? 'caution' : 'neutral'}
            />
            <Row label={t('dash.partPaid')} value={snapshot.cash.partiallyPaidCashOrders} />
          </Panel>
        ) : null}

        {snapshot.operations ? (
          <Panel title={t('dash.fulfilment')} href="/warehouse" testId="panel-fulfilment">
            <Row
              label={t('dash.awaitingWarehouse')}
              value={snapshot.operations.ordersAwaitingWarehouse}
            />
            <Row label={t('dash.beingPicked')} value={snapshot.operations.warehouseInProgress} />
            <Row label={t('dash.readyToGo')} value={snapshot.operations.warehousePrepared} />
            <Row
              label={t('dash.deliveriesPending')}
              value={snapshot.operations.deliveriesPending}
            />
            <Row
              label={t('dash.deliveriesDispatched')}
              value={snapshot.operations.deliveriesDispatched}
            />
            <Row
              label={t('dash.failedDeliveries')}
              value={snapshot.operations.failedDeliveriesOpen}
              tone={snapshot.operations.failedDeliveriesOpen > 0 ? 'critical' : 'neutral'}
            />
            <Row label={t('dash.completedToday')} value={snapshot.operations.ordersCompletedToday} />
          </Panel>
        ) : null}

        {snapshot.inventory ? (
          <Panel title={t('dash.inventory')} href="/exceptions" testId="panel-inventory">
            <Row
              label={t('dash.lowStock')}
              value={snapshot.inventory.lowStockProducts}
              tone={snapshot.inventory.lowStockProducts > 0 ? 'caution' : 'neutral'}
            />
            <Row
              label={t('dash.openDiscrepancies')}
              value={snapshot.inventory.openDiscrepancies}
            />
            <Row
              label={t('dash.shortfalls')}
              value={snapshot.inventory.reservationShortfalls}
              tone={snapshot.inventory.reservationShortfalls > 0 ? 'critical' : 'neutral'}
            />
            <Row
              label={t('dash.returnsOpen')}
              value={snapshot.inventory.returnsAwaitingProcessing}
            />
          </Panel>
        ) : null}
      </div>
    </>
  );
}

const SEVERITY_TONE: Readonly<Record<AttentionSeverity, 'critical' | 'caution' | 'neutral'>> = {
  CRITICAL: 'critical',
  HIGH: 'caution',
  NORMAL: 'neutral',
};

function severityKey(severity: AttentionSeverity): MessageKey {
  return `sev.${severity.toLowerCase()}` as MessageKey;
}

function AttentionRow({ item, currency }: { item: AttentionItem; currency: string }) {
  return (
    <Link href={item.href} className="block" data-testid="attention-item" data-kind={item.kind}>
      <Card className="flex flex-wrap items-center justify-between gap-3 transition-colors hover:border-border-strong">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY_TONE[item.severity]}>{t(severityKey(item.severity))}</Badge>
            <span className="font-mono text-xs text-ink-faint">{item.reference}</span>
          </div>
          <div className="mt-1 text-sm text-ink">{item.title}</div>
        </div>
        <div className="text-right text-sm">
          {item.amountMinor !== null ? (
            <div className="tabular font-medium text-ink">
              {formatMoney({ amountMinor: item.amountMinor, currency })}
            </div>
          ) : null}
          <div className="tabular text-xs text-ink-faint">{formatAge(item.ageHours)}</div>
        </div>
      </Card>
    </Link>
  );
}

/** Hours below a day, days above it. "73h" is a number somebody has to divide. */
function formatAge(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Seven bars, drawn with CSS.
 *
 * No charting library. One small comparison does not justify a dependency, a bundle and a
 * theming surface — and a bar whose height is a percentage of the largest value is the whole of
 * what this chart says.
 */
function SevenDayBars({ snapshot }: { snapshot: DashboardSnapshot }) {
  const showOrders = snapshot.sales !== null;
  const values = snapshot.series.map((point) =>
    showOrders ? point.orderValueMinor : point.confirmedPaymentsMinor,
  );
  const peak = values.reduce((max, value) => (value > max ? value : max), 0n);

  return (
    <div>
      <div className="mb-2 text-xs text-ink-muted">
        {showOrders ? t('dash.chartOrders') : t('dash.chartPayments')}
      </div>
      <div className="flex h-24 items-end gap-2" data-testid="seven-day-chart">
        {snapshot.series.map((point, index) => {
          const value = values[index]!;
          // Zero-height bars are given a sliver so a quiet day reads as "nothing", not as a
          // missing column that suggests the chart is broken.
          const percent = peak === 0n ? 2 : Math.max(2, Number((value * 100n) / peak));
          return (
            <div key={point.dateKey} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-accent/70"
                style={{ height: `${percent}%` }}
                title={`${point.dateKey}: ${formatMoney({ amountMinor: value, currency: snapshot.currency })}`}
              />
              <div className="text-[10px] text-ink-faint">{point.dateKey.slice(8)}</div>
            </div>
          );
        })}
      </div>
      {peak === 0n ? (
        <p className="mt-2 text-xs text-ink-faint">{t('dash.nothingYet')}</p>
      ) : null}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  href,
  tone = 'neutral',
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  href: string;
  tone?: 'neutral' | 'critical';
  testId: string;
}) {
  return (
    <Link href={href} className="block" data-testid={testId}>
      <Card className="transition-colors hover:border-border-strong">
        <div className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</div>
        <div
          className={`tabular mt-2 text-2xl font-semibold ${
            tone === 'critical' ? 'text-critical' : 'text-ink'
          }`}
        >
          {value}
        </div>
        <div className="mt-0.5 text-xs text-ink-faint">{sub}</div>
      </Card>
    </Link>
  );
}

function Panel({
  title,
  href,
  children,
  testId,
}: {
  title: string;
  href: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <Link href={href} className="text-xs text-accent hover:underline">
          Open
        </Link>
      </div>
      <div className="space-y-1.5 text-sm">{children}</div>
    </Card>
  );
}

function Row({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'caution' | 'critical';
}) {
  const toneClass =
    tone === 'critical' ? 'text-critical' : tone === 'caution' ? 'text-caution' : 'text-ink';

  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-ink-muted">
        {label}
        {hint ? <span className="ml-1 text-xs text-ink-faint">({hint})</span> : null}
      </span>
      <span className={`tabular font-medium ${toneClass}`}>{value}</span>
    </div>
  );
}
