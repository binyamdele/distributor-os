import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { listCustomers } from '@/modules/customers';
import { can } from '@/platform/rbac';
import { formatMoney } from '@/platform/money';
import { t } from '@/platform/i18n';
import { Badge, Button, EmptyState, Input, PageHeader, TableWrap, Td, Th } from '@/components/ui';

const CREDIT_TONE = {
  CASH_ONLY: 'neutral',
  CREDIT_ALLOWED: 'positive',
  SUSPENDED: 'critical',
} as const;

const CREDIT_LABEL = {
  CASH_ONLY: 'credit.cashOnly',
  CREDIT_ALLOWED: 'credit.creditAllowed',
  SUSPENDED: 'credit.suspended',
} as const;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requirePermission('read:customer');
  const { q } = await searchParams;

  const customers = await withTenant(session.organizationId, (tx) =>
    listCustomers(tx, { search: q }),
  );

  return (
    <>
      <PageHeader
        title={t('customer.title')}
        action={
          can(session.role, 'write:customer') ? (
            <Link href="/customers/new">
              <Button>{t('customer.new')}</Button>
            </Link>
          ) : undefined
        }
      />

      <form className="mb-4 max-w-sm">
        <Input name="q" defaultValue={q ?? ''} placeholder={t('action.search')} />
      </form>

      <TableWrap>
        <thead>
          <tr>
            <Th>{t('customer.companyName')}</Th>
            <Th>{t('customer.contactName')}</Th>
            <Th>{t('customer.phone')}</Th>
            <Th>{t('customer.creditStatus')}</Th>
            <Th className="text-right">{t('customer.creditLimit')}</Th>
            <Th className="text-right">{t('customer.paymentTerms')}</Th>
          </tr>
        </thead>
        <tbody>
          {customers.map((customer) => (
            <tr key={customer.id} className="hover:bg-surface-sunken">
              <Td>
                <Link
                  href={`/customers/${customer.id}`}
                  className="font-medium text-accent hover:underline"
                >
                  {customer.companyName}
                </Link>
              </Td>
              <Td className="text-ink-muted">{customer.contactName ?? '—'}</Td>
              <Td className="tabular text-ink-muted">{customer.phone ?? '—'}</Td>
              <Td>
                <Badge tone={CREDIT_TONE[customer.creditStatus]}>
                  {t(CREDIT_LABEL[customer.creditStatus])}
                </Badge>
              </Td>
              <Td className="tabular text-right">
                {customer.creditLimitMinor > 0n
                  ? formatMoney({
                      amountMinor: customer.creditLimitMinor,
                      currency: session.currency,
                    })
                  : '—'}
              </Td>
              <Td className="tabular text-right text-ink-muted">
                {customer.paymentTermsDays > 0 ? `${customer.paymentTermsDays} d` : '—'}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {customers.length === 0 ? <EmptyState message={t('customer.empty')} /> : null}
    </>
  );
}
