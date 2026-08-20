import { requirePermission } from '@/app/lib/session';
import { t } from '@/platform/i18n';
import { PageHeader } from '@/components/ui';
import { ProductForm } from '../product-form';

export default async function NewProductPage() {
  const session = await requirePermission('write:product');

  return (
    <>
      <PageHeader
        title={t('product.new')}
        description="Aliases matter: they are how a customer's wording is matched to this product."
      />
      <ProductForm currency={session.currency} />
    </>
  );
}
