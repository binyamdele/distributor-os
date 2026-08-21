import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { followUpQueue } from '@/modules/followups';
import { followUpMetrics } from '@/modules/orders/metrics';
import { can } from '@/platform/rbac';
import { formatMoney } from '@/platform/money';
import { formatDate, t } from '@/platform/i18n';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { CompleteFollowUpForm, SnoozeForm } from './follow-up-form';

/**
 * The follow-up queue.
 *
 * Overdue first, then due today, then upcoming — ordered by due date and nothing cleverer. A
 * model ranking a sales queue would be unexplainable to the person working it, and the honest
 * ordering is the one they would use themselves.
 *
 * Nothing on this page calls an AI provider. The queue is the part of the workflow a distributor
 * cannot afford to have degrade when a provider is unreachable.
 */
export default async function FollowUpsPage() {
  const session = await requirePermission('read:follow-up');

  const { rows, metrics } = await withTenant(session.organizationId, async (tx) => ({
    rows: await followUpQueue(tx, { includeUpcoming: true }),
    metrics: await followUpMetrics(tx),
  }));

  const overdue = rows.filter((row) => row.overdue);
  const upcoming = rows.filter((row) => !row.overdue);
  const editable = can(session.role, 'complete:follow-up');

  return (
    <>
      <PageHeader
        title={t('followUp.title')}
        description="Quotations that have been sent and not yet answered."
      />

      <div className="mb-6 flex flex-wrap gap-x-8 gap-y-2 rounded-lg border border-border-subtle bg-surface-raised px-5 py-3 text-sm">
        <Metric label={t('followUp.overdue')} value={metrics.overdueFollowUps} tone="caution" />
        <Metric label="Open" value={metrics.openFollowUps} />
        <Metric label="Completed" value={metrics.completedFollowUps} />
        <Metric
          label="Completion rate"
          value={
            metrics.completionRate === null
              ? '—'
              : `${Math.round(metrics.completionRate * 100)}%`
          }
        />
      </div>

      {overdue.length > 0 ? (
        <Section title={t('followUp.overdue')} tone="caution">
          {overdue.map((row) => (
            <FollowUpCard
              key={row.id}
              row={row}
              locale={session.locale}
              timezone={session.timezone}
              editable={editable}
            />
          ))}
        </Section>
      ) : null}

      {upcoming.length > 0 ? (
        <Section title={t('followUp.upcoming')}>
          {upcoming.map((row) => (
            <FollowUpCard
              key={row.id}
              row={row}
              locale={session.locale}
              timezone={session.timezone}
              editable={editable}
            />
          ))}
        </Section>
      ) : null}

      {rows.length === 0 ? <EmptyState message={t('followUp.empty')} /> : null}
    </>
  );
}

function Section({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'caution';
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2
        className={`mb-3 text-sm font-semibold ${tone === 'caution' ? 'text-caution' : 'text-ink'}`}
      >
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function FollowUpCard({
  row,
  locale,
  timezone,
  editable,
}: {
  row: Awaited<ReturnType<typeof followUpQueue>>[number];
  locale: 'en' | 'am';
  timezone: string;
  editable: boolean;
}) {
  return (
    <Card data-testid="follow-up" className={row.overdue ? 'border-caution/40' : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/quotations/${row.quotationId}`}
            className="font-mono font-medium text-accent hover:underline"
          >
            {row.quotationNumber}
          </Link>
          <div className="mt-0.5 text-ink">{row.customerName}</div>
          {/* Contact details, so the salesperson can act without a second lookup. */}
          {row.customerPhone ? (
            <div className="tabular mt-0.5 text-xs text-ink-muted">{row.customerPhone}</div>
          ) : null}
        </div>

        <div className="text-right text-sm">
          <div className="tabular font-medium text-ink">
            {formatMoney({ amountMinor: row.grandTotalMinor, currency: row.currency })}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">
            {t('followUp.attempt')} {row.sequence}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted">
        <span>
          {t('followUp.dueAt')} {formatDate(row.dueAt, locale, timezone)}
        </span>
        {row.sentAt ? (
          <span>
            Sent {formatDate(row.sentAt, locale, timezone)} · {row.daysSinceSent} days ago
          </span>
        ) : null}
        {row.overdue ? (
          <Badge tone="caution">{t('followUp.overdue')}</Badge>
        ) : (
          <Badge>{t('followUp.dueToday')}</Badge>
        )}
        {row.status === 'SNOOZED' ? <Badge>Snoozed</Badge> : null}
      </div>

      {editable ? (
        <div className="mt-4 space-y-3 border-t border-border-subtle pt-3">
          <CompleteFollowUpForm followUpId={row.id} />
          <SnoozeForm followUpId={row.id} />
        </div>
      ) : null}
    </Card>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number | string;
  tone?: 'neutral' | 'caution';
}) {
  return (
    <div>
      <div className="text-xs tracking-wide text-ink-muted uppercase">{label}</div>
      <div
        className={`tabular mt-0.5 text-lg font-semibold ${
          tone === 'caution' && value !== 0 ? 'text-caution' : 'text-ink'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
