import Link from 'next/link';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { freeStock, isLowStock, listProducts } from '@/modules/catalog';
import { can } from '@/platform/rbac';
import { formatMoney } from '@/platform/money';
import { t } from '@/platform/i18n';
import { Badge, Button, EmptyState, Input, PageHeader, TableWrap, Td, Th } from '@/components/ui';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requirePermission('read:product');
  const { q } = await searchParams;

  const products = await withTenant(session.organizationId, (tx) =>
    listProducts(tx, { search: q, includeInactive: true }),
  );

  return (
    <>
      <PageHeader
        title={t('product.title')}
        action={
          can(session.role, 'write:product') ? (
            <Link href="/products/new">
              <Button>{t('product.new')}</Button>
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
            <Th>{t('product.sku')}</Th>
            <Th>{t('product.name')}</Th>
            <Th className="text-right">{t('product.price')}</Th>
            <Th className="text-right">{t('product.available')}</Th>
            <Th className="text-right">{t('product.reserved')}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr key={product.id} className="hover:bg-surface-sunken">
              <Td className="font-mono text-xs text-ink-muted">{product.sku}</Td>
              <Td>
                <Link
                  href={`/products/${product.id}`}
                  className="font-medium text-accent hover:underline"
                >
                  {product.name}
                </Link>
                <span className="ml-2 text-xs text-ink-faint">{product.unit}</span>
              </Td>
              <Td className="tabular text-right">
                {formatMoney({
                  amountMinor: product.sellingPriceMinor,
                  currency: session.currency,
                })}
              </Td>
              <Td className="tabular text-right">{product.availableStock.toLocaleString()}</Td>
              <Td className="tabular text-right text-ink-muted">
                {product.reservedStock > 0 ? product.reservedStock.toLocaleString() : '—'}
              </Td>
              <Td>
                <div className="flex gap-1.5">
                  {isLowStock(product) ? (
                    <Badge tone="caution">
                      {t('product.lowStock')} · {freeStock(product).toLocaleString()}
                    </Badge>
                  ) : null}
                  {!product.active ? <Badge>{t('product.inactive')}</Badge> : null}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      {products.length === 0 ? <EmptyState message={t('product.empty')} /> : null}
    </>
  );
}
