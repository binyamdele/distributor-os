'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_DURATION_MS, login, revokeSession } from '@/modules/identity';
import { t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';

export interface LoginState {
  readonly error?: string;
}

export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: t('auth.invalidCredentials') };
  }

  const result = await login(email, password);
  if (!result.ok) {
    // The module returns a message key, so the copy lives in the catalogue rather than here.
    return { error: t(result.error.message as MessageKey) };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, result.value.token, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure in production only, so a pilot can run over plain HTTP on a local network.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DURATION_MS / 1000,
  });

  redirect('/');
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  await revokeSession(store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
  redirect('/login');
}
