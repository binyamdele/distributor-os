import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { getCustomer } from '@/modules/customers';
import { auditTrailFor } from '@/modules/audit';
import { can } from '@/platform/rbac';
import { toDecimalString } from '@/platform/money';
import { formatDateTime, t } from '@/platform/i18n';
import { Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { CustomerForm } from '../customer-form';
import { updateCustomerAction } from '../actions';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission('read:customer');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const customer = await getCustomer(tx, id);
    if (!customer.ok) return null;
    const history = can(session.role, 'read:audit')
      ? await auditTrailFor(tx, 'customer', id)
      : [];
    return { customer: customer.value, history };
  });

  if (!data) notFound();

  const { customer, history } = data;
  const editable = can(session.role, 'write:customer');

  return (
    <>
      <PageHeader title={customer.companyName} description={customer.address ?? undefined} />

      {editable ? (
        <CustomerForm
          action={updateCustomerAction.bind(null, id)}
          submitLabel={t('action.save')}
          currency={session.currency}
          values={{
            companyName: customer.companyName,
            contactName: customer.contactName,
            phone: customer.phone,
            email: customer.email,
            preferredLanguage: customer.preferredLanguage,
            address: customer.address,
            creditStatus: customer.creditStatus,
            creditLimit: toDecimalString({
              amountMinor: customer.creditLimitMinor,
              currency: session.currency,
            }),
            paymentTermsDays: customer.paymentTermsDays,
            notes: customer.notes,
          }}
        />
      ) : (
        <Card className="space-y-2 text-sm">
          <Row label={t('customer.contactName')} value={customer.contactName} />
          <Row label={t('customer.phone')} value={customer.phone} />
          <Row label={t('customer.email')} value={customer.email} />
          <Row label={t('customer.creditStatus')} value={customer.creditStatus} />
        </Card>
      )}

      {history.length > 0 ? (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('activity.title')}</h2>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('activity.action')}</Th>
                <Th>{t('activity.actor')}</Th>
                <Th>{t('activity.when')}</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <Td className="font-mono text-xs">{entry.action}</Td>
                  <Td className="text-ink-muted">
                    {entry.actorType === 'USER' ? 'User' : t('activity.system')}
                  </Td>
                  <Td className="text-ink-muted">
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

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink">{value ?? '—'}</span>
    </div>
  );
}
