import { redirect } from 'next/navigation';
import { currentSession } from '@/app/lib/session';
import { t } from '@/platform/i18n';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  if (await currentSession()) redirect('/');

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-lg font-semibold text-ink">{t('app.name')}</h1>
          <p className="mt-1 text-sm text-ink-muted">{t('app.tagline')}</p>
        </div>

        <LoginForm />

        <p className="mt-8 text-xs leading-relaxed text-ink-faint">
          Demo accounts are seeded with synthetic data. Prices and customers are invented and do
          not reflect any real market.
        </p>
      </div>
    </main>
  );
}
