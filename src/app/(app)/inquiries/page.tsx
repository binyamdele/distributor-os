import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { listInquiries } from '@/modules/inquiries';
import { parsingMetrics } from '@/modules/inquiries/metrics';
import { can } from '@/platform/rbac';
import { formatDateTime, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, Button, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

export const STATUS_TONE = {
  RECEIVED: 'neutral',
  PARSING: 'accent',
  NEEDS_REVIEW: 'caution',
  READY_FOR_QUOTE: 'positive',
  PARSE_FAILED: 'critical',
  CANCELLED: 'neutral',
} as const;

export function statusKey(status: string): MessageKey {
  return `status.${status.toLowerCase()}` as MessageKey;
}

export default async function InquiriesPage() {
  const session = await requirePermission('read:inquiry');

  const { rows, metrics } = await withTenant(session.organizationId, async (tx) => ({
    rows: await listInquiries(tx),
    metrics: await parsingMetrics(tx),
  }));

  return (
    <>
      <PageHeader
        title={t('inquiry.title')}
        description="What customers asked for, and how far it has been worked."
        action={
          can(session.role, 'write:inquiry') ? (
            <Link href="/inquiries/new">
              <Button>{t('inquiry.new')}</Button>
            </Link>
          ) : undefined
        }
      />

      {/* A small strip rather than a dashboard: these are the Phase 2 numbers that say whether
          the parser is earning its place. The real dashboard is Phase 7. */}
      <div className="mb-6 flex flex-wrap gap-x-8 gap-y-2 rounded-lg border border-border-subtle bg-surface-raised px-5 py-3 text-sm">
        <Metric label="Awaiting review" value={metrics.awaitingReview} />
        <Metric label="Ready for quote" value={metrics.readyForQuote} />
        <Metric
          label="Parse success"
          value={
            metrics.parseSuccessRate === null
              ? '—'
              : `${Math.round(metrics.parseSuccessRate * 100)}%`
          }
        />
        <Metric label="Parse failures" value={metrics.parseFailed} />
      </div>

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('inquiry.rawMessage')}</Th>
            <Th>{t('inquiry.customer')}</Th>
            <Th className="text-right">Items</Th>
            <Th>Status</Th>
            <Th>{t('activity.when')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-surface-sunken">
              <Td className="max-w-md">
                <Link
                  href={`/inquiries/${row.id}`}
                  className="line-clamp-2 font-medium text-accent hover:underline"
                >
                  {row.normalizedText}
                </Link>
              </Td>
              <Td className="text-ink-muted">{row.customerName ?? '—'}</Td>
              <Td className="tabular text-right">
                {row.itemCount}
                {row.needsAttention > 0 ? (
                  <span className="ml-1.5 text-xs text-caution">({row.needsAttention})</span>
                ) : null}
              </Td>
              <Td>
                <Badge tone={STATUS_TONE[row.status]}>{t(statusKey(row.status))}</Badge>
              </Td>
              <Td className="text-ink-muted whitespace-nowrap">
                {formatDateTime(row.createdAt, session.locale, session.timezone)}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {rows.length === 0 ? <EmptyState message={t('inquiry.empty')} /> : null}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-xs tracking-wide text-ink-muted uppercase">{label}</div>
      <div className="tabular mt-0.5 text-lg font-semibold text-ink">{value}</div>
    </div>
  );
}
