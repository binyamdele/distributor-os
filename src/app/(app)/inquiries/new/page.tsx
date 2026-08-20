import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { listCustomers } from '@/modules/customers';
import { t } from '@/platform/i18n';
import { PageHeader } from '@/components/ui';
import { InquiryForm } from './inquiry-form';

export default async function NewInquiryPage() {
  const session = await requirePermission('write:inquiry');

  const customers = await withTenant(session.organizationId, (tx) => listCustomers(tx));

  return (
    <>
      <PageHeader
        title={t('inquiry.new')}
        description="Paste a message from WhatsApp, an email, or a note from a phone call."
      />
      <InquiryForm
        customers={customers.map((customer) => ({
          id: customer.id,
          companyName: customer.companyName,
        }))}
      />
    </>
  );
}
