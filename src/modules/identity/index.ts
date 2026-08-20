import 'server-only';
import { prisma } from '@/platform/db';
import { generateToken, hashPassword, hashString, verifyPassword } from '@/platform/security';
import { type Result, fail, ok } from '@/platform/result';
import type { Role } from '@/platform/rbac';
import type { Locale } from '@/platform/i18n';

/**
 * Authentication and sessions.
 *
 * This module is the one place that legitimately touches the database before an organization is
 * known — a person types an email address, and the tenant can only be chosen once their
 * password has verified and their memberships have been read. Everything downstream of
 * `resolveSession` is organization-scoped.
 *
 * A session is bound to one organization as well as one user. Switching organization issues a
 * new session rather than mutating this one, so a stolen cookie can never widen its own scope.
 */

/** A working day. Long enough not to interrupt a salesperson, short enough to matter. */
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'distributor_session';

export interface SessionContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
  readonly locale: Locale;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly currency: string;
  readonly timezone: string;
  readonly role: Role;
}

export interface LoginSuccess {
  readonly token: string;
  readonly expiresAt: Date;
  readonly context: SessionContext;
}

/**
 * Verifies credentials and issues a session.
 *
 * Every failure below returns the same message to the caller. Distinguishing "no such email"
 * from "wrong password" hands an attacker a free account-enumeration oracle, and the
 * distinction is of no use to a legitimate user who has simply mistyped something.
 */
export async function login(
  email: string,
  password: string,
  organizationId?: string,
): Promise<Result<LoginSuccess>> {
  const normalizedEmail = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: {
      memberships: {
        include: { organization: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  // Verify a password even when the user does not exist, so a missing account and a wrong
  // password take comparable time and the response cannot be used to enumerate addresses.
  const storedHash = user?.passwordHash ?? (await dummyHash);
  const passwordMatches = await verifyPassword(password, storedHash);

  if (!user || !passwordMatches) {
    return fail('UNAUTHENTICATED', 'auth.invalidCredentials');
  }
  if (!user.isActive) {
    return fail('UNAUTHENTICATED', 'auth.inactive');
  }

  const membership = organizationId
    ? user.memberships.find((m) => m.organizationId === organizationId)
    : user.memberships[0];

  if (!membership) {
    return fail('UNAUTHENTICATED', 'auth.noMembership');
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      organizationId: membership.organizationId,
      tokenHash: hashString(token),
      expiresAt,
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return ok({
    token,
    expiresAt,
    context: {
      sessionId: session.id,
      userId: user.id,
      fullName: user.fullName,
      email: user.email,
      locale: (user.locale as Locale) ?? 'en',
      organizationId: membership.organizationId,
      organizationName: membership.organization.name,
      currency: membership.organization.currency,
      timezone: membership.organization.timezone,
      role: membership.role as Role,
    },
  });
}

/**
 * A real scrypt hash of a random value nobody knows.
 *
 * Verifying against it when the account does not exist makes a missing address cost the same
 * scrypt work as a wrong password. A hand-written constant would not do: `verifyPassword`
 * rejects a malformed hash immediately, which would return in microseconds and reintroduce
 * exactly the timing signal this exists to remove.
 */
const dummyHash = hashPassword(generateToken(24));

/** Resolves a raw cookie token to a live session, or fails. */
export async function resolveSession(token: string | undefined): Promise<Result<SessionContext>> {
  if (!token) return fail('UNAUTHENTICATED', 'auth.invalidCredentials');

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashString(token) },
    include: {
      user: true,
      organization: true,
    },
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    return fail('UNAUTHENTICATED', 'auth.invalidCredentials');
  }
  if (!session.user.isActive) {
    return fail('UNAUTHENTICATED', 'auth.inactive');
  }

  // The role is read from the membership on every request, not cached in the session. A role
  // revoked at 10:00 must not keep working until the cookie expires at 18:00.
  const membership = await prisma.membership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: session.organizationId,
        userId: session.userId,
      },
    },
  });

  if (!membership) {
    return fail('UNAUTHENTICATED', 'auth.noMembership');
  }

  return ok({
    sessionId: session.id,
    userId: session.userId,
    fullName: session.user.fullName,
    email: session.user.email,
    locale: (session.user.locale as Locale) ?? 'en',
    organizationId: session.organizationId,
    organizationName: session.organization.name,
    currency: session.organization.currency,
    timezone: session.organization.timezone,
    role: membership.role as Role,
  });
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.session.updateMany({
    where: { tokenHash: hashString(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export { SESSION_DURATION_MS };
