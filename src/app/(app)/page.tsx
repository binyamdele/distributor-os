import Link from 'next/link';
import { requireSession } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { isLowStock } from '@/modules/catalog';
import { can } from '@/platform/rbac';
import { t } from '@/platform/i18n';
import { Card, PageHeader } from '@/components/ui';

/**
 * The dashboard, Phase 1 edition.
 *
 * It shows only what the foundation can actually count. The brief's real dashboard — sales
 * today, quotations awaiting follow-up, overdue receivables, warehouse and delivery queues —
 * needs the modules that Phases 2 to 7 add, and inventing placeholder figures now would make
 * the page look finished while telling the owner nothing true.
 */
export default async function DashboardPage() {
  const session = await requireSession();

  const stats = await withTenant(session.organizationId, async (tx) => {
    const [customers, products, allProducts] = await Promise.all([
      tx.customer.count(),
      tx.product.count({ where: { active: true } }),
      tx.product.findMany({
        where: { active: true },
        select: { availableStock: true, reservedStock: true, reorderThreshold: true },
      }),
    ]);
    return { customers, products, lowStock: allProducts.filter(isLowStock).length };
  });

  return (
    <>
      <PageHeader
        title={`${t('dashboard.welcome')}, ${session.fullName.split(' ')[0]}`}
        description={session.organizationName}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={t('dashboard.customers')} value={stats.customers} href="/customers" />
        <Stat label={t('dashboard.products')} value={stats.products} href="/products" />
        <Stat
          label={t('dashboard.lowStock')}
          value={stats.lowStock}
          href="/products"
          tone={stats.lowStock > 0 ? 'caution' : 'neutral'}
        />
      </div>

      {can(session.role, 'read:dashboard') ? (
        <Card className="mt-6 border-dashed">
          <h2 className="text-sm font-semibold text-ink">Phase 1 of 8</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
            {t('dashboard.phaseNotice')}
          </p>
        </Card>
      ) : null}
    </>
  );
}

function Stat({
  label,
  value,
  href,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  href: string;
  tone?: 'neutral' | 'caution';
}) {
  return (
    <Link href={href} className="block">
      <Card className="transition-colors hover:border-border-strong">
        <div className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</div>
        <div
          className={`tabular mt-2 text-3xl font-semibold ${
            tone === 'caution' && value > 0 ? 'text-caution' : 'text-ink'
          }`}
        >
          {value}
        </div>
      </Card>
    </Link>
  );
}
