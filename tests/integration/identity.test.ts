import { beforeEach, describe, expect, it } from 'vitest';
import { login, resolveSession, revokeSession } from '@/modules/identity';
import { hashPassword, hashString } from '@/platform/security';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';

const PASSWORD = 'IntegrationTestPassword1';

describe('authentication', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let email: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'SALESPERSON');
    const user = await owner.user.findUniqueOrThrow({ where: { id: org.userId } });
    email = user.email;
  });

  it('issues a session for correct credentials', async () => {
    const result = await login(email, PASSWORD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.context).toMatchObject({
      userId: org.userId,
      organizationId: org.organizationId,
      organizationName: 'Addis Build Supply',
      currency: 'ETB',
      role: 'SALESPERSON',
    });
    expect(result.value.token).toBeTruthy();
  });

  it('stores only the hash of the token', async () => {
    const result = await login(email, PASSWORD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await owner.session.findUniqueOrThrow({
      where: { tokenHash: hashString(result.value.token) },
    });
    // The raw token must not be recoverable from the database.
    expect(stored.tokenHash).not.toBe(result.value.token);
  });

  it('rejects a wrong password', async () => {
    const result = await login(email, 'WrongPasswordEntirely1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('UNAUTHENTICATED');
  });

  it('gives the same answer for an unknown address as for a wrong password', async () => {
    const unknown = await login('nobody@nowhere.example', PASSWORD);
    const wrong = await login(email, 'WrongPasswordEntirely1');

    expect(unknown.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    // Identical refusals: the response must not reveal whether the account exists.
    expect(unknown.ok === false && unknown.error.message).toBe(
      wrong.ok === false && wrong.error.message,
    );
  });

  it('refuses a deactivated user', async () => {
    await owner.user.update({ where: { id: org.userId }, data: { isActive: false } });
    const result = await login(email, PASSWORD);
    expect(result.ok === false && result.error.message).toBe('auth.inactive');
  });

  it('refuses a user with no membership', async () => {
    await owner.membership.deleteMany({ where: { userId: org.userId } });
    const result = await login(email, PASSWORD);
    expect(result.ok === false && result.error.message).toBe('auth.noMembership');
  });

  it('is not case-sensitive about the email address', async () => {
    const result = await login(email.toUpperCase(), PASSWORD);
    expect(result.ok).toBe(true);
  });

  it('does not accept a password stored for a different user', async () => {
    const other = await seedOrg('Rift Valley Trading');
    await owner.user.update({
      where: { id: other.userId },
      data: { passwordHash: await hashPassword('ADifferentPassword99') },
    });
    const result = await login(email, 'ADifferentPassword99');
    expect(result.ok).toBe(false);
  });
});

describe('sessions', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply', 'FINANCE');
    const user = await owner.user.findUniqueOrThrow({ where: { id: org.userId } });
    const result = await login(user.email, PASSWORD);
    if (!result.ok) throw new Error('login failed in setup');
    token = result.value.token;
  });

  it('resolves a live session', async () => {
    const resolved = await resolveSession(token);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.value.role).toBe('FINANCE');
  });

  it('refuses a missing token', async () => {
    expect((await resolveSession(undefined)).ok).toBe(false);
  });

  it('refuses an unknown token', async () => {
    expect((await resolveSession('not-a-real-token')).ok).toBe(false);
  });

  it('refuses an expired session', async () => {
    await owner.session.updateMany({
      where: { tokenHash: hashString(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await resolveSession(token)).ok).toBe(false);
  });

  it('refuses a revoked session', async () => {
    await revokeSession(token);
    expect((await resolveSession(token)).ok).toBe(false);
  });

  it('reflects a role change immediately, without waiting for the cookie to expire', async () => {
    // The role is read from the membership on every request rather than baked into the session.
    await owner.membership.updateMany({
      where: { userId: org.userId },
      data: { role: 'WAREHOUSE' },
    });

    const resolved = await resolveSession(token);
    expect(resolved.ok && resolved.value.role).toBe('WAREHOUSE');
  });

  it('stops working when the membership is removed', async () => {
    await owner.membership.deleteMany({ where: { userId: org.userId } });
    expect((await resolveSession(token)).ok).toBe(false);
  });

  it('stops working when the user is deactivated', async () => {
    await owner.user.update({ where: { id: org.userId }, data: { isActive: false } });
    expect((await resolveSession(token)).ok).toBe(false);
  });
});
