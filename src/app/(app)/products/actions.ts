'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { adjustStock, createProduct } from '@/modules/catalog';

export interface ProductFormState {
  readonly error?: string;
  readonly field?: string;
  readonly ok?: boolean;
}

export async function createProductAction(
  _previous: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const session = await requirePermission('write:product');

  const result = await withTenant(session.organizationId, (tx) =>
    createProduct(
      tx,
      actorFrom(session),
      {
        sku: formData.get('sku'),
        name: formData.get('name'),
        category: formData.get('category'),
        unit: formData.get('unit'),
        sellingPrice: formData.get('sellingPrice'),
        taxRatePercent: formData.get('taxRatePercent'),
        availableStock: formData.get('availableStock'),
        reorderThreshold: formData.get('reorderThreshold'),
        active: formData.get('active') === 'on',
        aliases: formData.get('aliases'),
      },
      session.currency,
    ),
  );

  if (!result.ok) {
    return { error: result.error.message, field: result.error.details?.field as string };
  }

  revalidatePath('/products');
  redirect(`/products/${result.value.id}`);
}

export async function adjustStockAction(
  productId: string,
  _previous: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  const session = await requirePermission('adjust:stock');

  const result = await withTenant(session.organizationId, (tx) =>
    adjustStock(tx, actorFrom(session), productId, {
      delta: formData.get('delta'),
      reason: formData.get('reason'),
    }),
  );

  if (!result.ok) {
    return { error: result.error.message, field: result.error.details?.field as string };
  }

  revalidatePath(`/products/${productId}`);
  revalidatePath('/products');
  return { ok: true };
}
