import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, type SessionContext, resolveSession } from '@/modules/identity';
import { type Permission, can } from '@/platform/rbac';
import type { ActorContext } from '@/platform/context';

/**
 * The bridge between HTTP and the business modules.
 *
 * The modules take an `ActorContext` and know nothing about cookies or redirects; this file is
 * the only place that turns one into the other. Keeping the boundary here is what lets the
 * modules be tested without a server.
 */

export async function currentSession(): Promise<SessionContext | null> {
  const store = await cookies();
  const result = await resolveSession(store.get(SESSION_COOKIE)?.value);
  return result.ok ? result.value : null;
}

/** For pages behind the app shell. Sends an unauthenticated visitor to the login screen. */
export async function requireSession(): Promise<SessionContext> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}

/**
 * Permission checks happen on the server, on every request, against the role read fresh from
 * the membership. Hiding a button in the UI is a courtesy to the user; this is the control.
 */
export async function requirePermission(permission: Permission): Promise<SessionContext> {
  const session = await requireSession();
  if (!can(session.role, permission)) redirect('/?denied=1');
  return session;
}

export function actorFrom(session: SessionContext): ActorContext {
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    role: session.role,
    source: 'web',
  };
}
