import Link from 'next/link';
import { requireSession } from '@/app/lib/session';
import { signOut } from '@/app/login/actions';
import { type Permission, can } from '@/platform/rbac';
import { type MessageKey, t } from '@/platform/i18n';
import { ROLE_LABEL_KEYS } from '@/platform/rbac';
import { Badge } from '@/components/ui';

/**
 * The app shell.
 *
 * Navigation is filtered by permission, so a warehouse user does not see a Customers tab they
 * cannot open. That is a courtesy, not a control — every page re-checks server-side, because a
 * hidden link is not a permission check.
 */
const NAV: { href: string; labelKey: MessageKey; permission: Permission }[] = [
  { href: '/', labelKey: 'nav.dashboard', permission: 'read:dashboard' },
  { href: '/inquiries', labelKey: 'nav.inquiries', permission: 'read:inquiry' },
  { href: '/customers', labelKey: 'nav.customers', permission: 'read:customer' },
  { href: '/products', labelKey: 'nav.products', permission: 'read:product' },
  { href: '/activity', labelKey: 'nav.activity', permission: 'read:audit' },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const visible = NAV.filter((item) => can(session.role, item.permission));

  return (
    <div className="min-h-screen">
      <header className="border-b border-border-subtle bg-surface-raised">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-ink">
              {session.organizationName}
            </span>
            <span className="text-xs text-ink-faint">{t('app.name')}</span>
          </div>

          <nav className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {visible.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
              >
                {t(item.labelKey)}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm text-ink">{session.fullName}</div>
              <div className="text-xs text-ink-faint">
                {t(ROLE_LABEL_KEYS[session.role] as MessageKey)}
              </div>
            </div>
            <Badge className="sm:hidden">{t(ROLE_LABEL_KEYS[session.role] as MessageKey)}</Badge>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md px-2 py-1.5 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
              >
                {t('nav.signOut')}
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
