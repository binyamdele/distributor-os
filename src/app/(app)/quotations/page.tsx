import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { listQuotations } from '@/modules/quotations';
import { formatMoney } from '@/platform/money';
import { formatDate, t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { Badge, EmptyState, PageHeader, TableWrap, Td, Th } from '@/components/ui';

export const QUOTE_STATUS_TONE = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'caution',
  APPROVED: 'positive',
  SENT: 'accent',
  ACCEPTED: 'positive',
  REJECTED: 'critical',
  EXPIRED: 'neutral',
  SUPERSEDED: 'neutral',
  CANCELLED: 'neutral',
} as const;

export function quoteStatusKey(status: string): MessageKey {
  return `quoteStatus.${status.toLowerCase()}` as MessageKey;
}

export default async function QuotationsPage() {
  const session = await requirePermission('read:quotation');

  const rows = await withTenant(session.organizationId, (tx) => listQuotations(tx));

  return (
    <>
      <PageHeader
        title={t('quote.title')}
        description="Drafted from reviewed inquiries. Prices are fixed at the moment of drafting."
      />

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('quote.number')}</Th>
            <Th>{t('quote.customer')}</Th>
            <Th className="text-right">{t('quote.total')}</Th>
            <Th>{t('quote.status')}</Th>
            <Th>{t('quote.validUntil')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-surface-sunken">
              <Td>
                <Link
                  href={`/quotations/${row.id}`}
                  className="font-mono font-medium text-accent hover:underline"
                >
                  {row.quotationNumber}
                </Link>
              </Td>
              <Td>{row.customerName}</Td>
              <Td className="tabular text-right">
                {formatMoney({ amountMinor: row.grandTotalMinor, currency: row.currency })}
              </Td>
              <Td>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={QUOTE_STATUS_TONE[row.status]}>{t(quoteStatusKey(row.status))}</Badge>
                  {row.status === 'PENDING_APPROVAL' && row.requiredLevel === 'SALES_MANAGER' ? (
                    <Badge tone="caution">Manager</Badge>
                  ) : null}
                  {row.requiredLevel === 'BLOCKED' ? <Badge tone="critical">Blocked</Badge> : null}
                </div>
              </Td>
              <Td className="text-ink-muted whitespace-nowrap">
                {formatDate(row.validityDate, session.locale, session.timezone)}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {rows.length === 0 ? <EmptyState message={t('quote.empty')} /> : null}
    </>
  );
}
