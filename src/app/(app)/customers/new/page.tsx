import { requirePermission } from '@/app/lib/session';
import { t } from '@/platform/i18n';
import { PageHeader } from '@/components/ui';
import { CustomerForm } from '../customer-form';
import { createCustomerAction } from '../actions';

export default async function NewCustomerPage() {
  const session = await requirePermission('write:customer');

  return (
    <>
      <PageHeader title={t('customer.new')} />
      <CustomerForm
        action={createCustomerAction}
        submitLabel={t('action.create')}
        currency={session.currency}
      />
    </>
  );
}
