'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_DURATION_MS, login, revokeSession } from '@/modules/identity';
import { config } from '@/platform/config';
import { log, rateLimit } from '@/platform/observability';
import { t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';

export interface LoginState {
  readonly error?: string;
}

export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: t('auth.invalidCredentials') };
  }

  /*
   * Throttled before the password is checked.
   *
   * Two reasons, and the second is the one usually forgotten. Obviously it stops a dictionary
   * attack. Less obviously, scrypt at N=2^15 costs the *server* real CPU per attempt, so an
   * unthrottled login endpoint is also a denial-of-service amplifier: a few hundred requests a
   * second would saturate the pilot's container using nothing but wrong passwords.
   *
   * Keyed on the email rather than the IP because a distributor's staff all sit behind one
   * office connection, and limiting by address would let one person's repeated typo lock out
   * the whole company.
   */
  const settings = config();
  if (settings.RATE_LIMIT_ENABLED) {
    const verdict = rateLimit.consume('login', email);
    if (!verdict.allowed) {
      log.warn({
        event: 'auth.rate_limited',
        // The email is not logged. A login log becomes a list of who works here, and a failed
        // one becomes a list of accounts worth attacking.
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return { error: t('auth.tooManyAttempts') };
    }
  }

  const result = await login(email, password);

  if (!result.ok) {
    log.info({ event: 'auth.login_failed', code: result.error.code });
    // The module returns a message key, so the copy lives in the catalogue rather than here.
    return { error: t(result.error.message as MessageKey) };
  }

  // A successful login forgives the window. Somebody who eventually remembers their password
  // should not be locked out by the attempts it took them.
  rateLimit.reset('login', email);

  const store = await cookies();
  store.set(SESSION_COOKIE, result.value.token, {
    httpOnly: true,
    /*
     * `lax` rather than `strict`.
     *
     * `strict` would drop the cookie when a user arrives from an external link — including the
     * links this product will eventually put in customer messages — and present them with a
     * login screen despite having a valid session. `lax` withholds the cookie on cross-site
     * POSTs, which is the case that matters, and Next.js Server Actions additionally verify the
     * Origin header against the host on every mutation.
     */
    sameSite: 'lax',
    // Secure in production and staging. In development a pilot machine may run on plain HTTP
    // over a local network, and a `secure` cookie would simply never be sent.
    secure: settings.APP_ENV === 'production' || settings.APP_ENV === 'staging',
    path: '/',
    maxAge: SESSION_DURATION_MS / 1000,
  });

  log.info({ event: 'auth.login_succeeded', userId: result.value.context.userId });

  redirect('/');
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  // Revoked server-side first, then the cookie is dropped. Doing it the other way round would
  // leave a live session behind for anyone who already copied the token.
  await revokeSession(token);
  store.delete(SESSION_COOKIE);

  log.info({ event: 'auth.logged_out' });
  redirect('/login');
}

/**
 * The origin a Server Action was invoked from, for diagnostics.
 *
 * Next.js already refuses a Server Action whose Origin does not match the Host, which is the
 * CSRF control. This only records it, so a blocked attempt is visible in the logs rather than
 * being an invisible 500 to whoever is investigating.
 */
export async function requestOrigin(): Promise<string | null> {
  const store = await headers();
  return store.get('origin');
}
