import { notFound } from 'next/navigation';
import { requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { freeStock, getProduct, isLowStock, stockHistory } from '@/modules/catalog';
import { can } from '@/platform/rbac';
import { formatMoney } from '@/platform/money';
import { formatDateTime, t } from '@/platform/i18n';
import { Badge, Card, PageHeader, TableWrap, Td, Th } from '@/components/ui';
import { StockAdjustForm } from '../product-form';
import { adjustStockAction } from '../actions';

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('read:product');
  const { id } = await params;

  const data = await withTenant(session.organizationId, async (tx) => {
    const product = await getProduct(tx, id);
    if (!product.ok) return null;
    return { product: product.value, history: await stockHistory(tx, id) };
  });

  if (!data) notFound();
  const { product, history } = data;

  return (
    <>
      <PageHeader
        title={product.name}
        description={`${product.sku} · ${product.category ?? 'Uncategorised'}`}
        action={
          <div className="flex gap-2">
            {isLowStock(product) ? <Badge tone="caution">{t('product.lowStock')}</Badge> : null}
            {!product.active ? <Badge>{t('product.inactive')}</Badge> : null}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <Metric
          label={t('product.price')}
          value={formatMoney({
            amountMinor: product.sellingPriceMinor,
            currency: session.currency,
          })}
        />
        <Metric label={t('product.available')} value={product.availableStock.toLocaleString()} />
        <Metric label={t('product.reserved')} value={product.reservedStock.toLocaleString()} />
        <Metric
          label="Free to sell"
          value={freeStock(product).toLocaleString()}
          tone={isLowStock(product) ? 'caution' : 'neutral'}
        />
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">
          {t('product.aliases')}{' '}
          <span className="font-normal text-ink-faint">({product.aliases.length})</span>
        </h2>
        {product.aliases.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {product.aliases.map((alias) => (
              <Badge key={alias.id} tone={alias.source === 'SEED' ? 'neutral' : 'accent'}>
                {alias.alias}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-faint">
            No aliases yet. Without them, a customer writing &ldquo;12mm&rdquo; will not be matched
            to this product.
          </p>
        )}
      </section>

      {can(session.role, 'adjust:stock') ? (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('product.adjustStock')}</h2>
          <Card>
            <StockAdjustForm action={adjustStockAction.bind(null, id)} unit={product.unit} />
          </Card>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">{t('product.stockHistory')}</h2>
          <TableWrap>
            <thead>
              <tr>
                <Th className="text-right">{t('product.adjustment')}</Th>
                <Th className="text-right">Balance</Th>
                <Th>{t('product.adjustmentReason')}</Th>
                <Th>{t('activity.when')}</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <Td
                    className={`tabular text-right font-medium ${
                      entry.delta > 0 ? 'text-positive' : 'text-critical'
                    }`}
                  >
                    {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                  </Td>
                  <Td className="tabular text-right">{entry.stockAfter.toLocaleString()}</Td>
                  <Td className="text-ink-muted">{entry.reason}</Td>
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

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'caution';
}) {
  return (
    <Card>
      <div className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</div>
      <div
        className={`tabular mt-1.5 text-xl font-semibold ${
          tone === 'caution' ? 'text-caution' : 'text-ink'
        }`}
      >
        {value}
      </div>
    </Card>
  );
}
