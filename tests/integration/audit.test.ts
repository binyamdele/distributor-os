import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@/platform/db';
import { auditTrailFor, recordAudit } from '@/modules/audit';
import { createCustomer } from '@/modules/customers';
import { owner, resetDatabase, seedOrg } from '../support/fixtures';

describe('the audit log', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrg('Addis Build Supply');
  });

  it('records a mutation with actor, action and new state', async () => {
    const created = await withTenant(org.organizationId, (tx) =>
      createCustomer(tx, org.context, { companyName: 'ABC Construction' }, 'ETB'),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const trail = await withTenant(org.organizationId, (tx) =>
      auditTrailFor(tx, 'customer', created.value.id),
    );

    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'customer.created',
      entityType: 'customer',
      actorType: 'USER',
      actorId: org.userId,
      source: 'test',
      aiInvolved: false,
    });
  });

  describe('sharing the transaction with the change it records', () => {
    it('rolls the audit row back when the mutation fails', async () => {
      // A deliberate failure after the audit row is written. If the two were not in one
      // transaction, the log would claim a customer was created that does not exist.
      await expect(
        withTenant(org.organizationId, async (tx) => {
          const created = await createCustomer(
            tx,
            org.context,
            { companyName: 'Doomed Customer' },
            'ETB',
          );
          expect(created.ok).toBe(true);
          throw new Error('simulated failure after the audit write');
        }),
      ).rejects.toThrow('simulated failure');

      expect(await owner.customer.count()).toBe(0);
      expect(await owner.auditEvent.count()).toBe(0);
    });

    it('commits both together when the mutation succeeds', async () => {
      await withTenant(org.organizationId, (tx) =>
        createCustomer(tx, org.context, { companyName: 'ABC Construction' }, 'ETB'),
      );
      expect(await owner.customer.count()).toBe(1);
      expect(await owner.auditEvent.count()).toBe(1);
    });
  });

  describe('sequence', () => {
    it('is gapless and ordered within an organization', async () => {
      for (const name of ['First', 'Second', 'Third']) {
        await withTenant(org.organizationId, (tx) =>
          createCustomer(tx, org.context, { companyName: name }, 'ETB'),
        );
      }

      const events = await owner.auditEvent.findMany({
        where: { organizationId: org.organizationId },
        orderBy: { sequence: 'asc' },
      });

      expect(events.map((e) => e.sequence)).toEqual([1n, 2n, 3n]);
    });

    it('stays gapless when writers run concurrently', async () => {
      // The advisory lock is the point of this test. Without it, concurrent transactions both
      // read the same max(sequence) and one insert violates the unique constraint — or worse,
      // two events share an ordinal and the history becomes ambiguous.
      const names = Array.from({ length: 8 }, (_, index) => `Concurrent ${index}`);

      await Promise.all(
        names.map((companyName) =>
          withTenant(org.organizationId, (tx) =>
            createCustomer(tx, org.context, { companyName }, 'ETB'),
          ),
        ),
      );

      const events = await owner.auditEvent.findMany({
        where: { organizationId: org.organizationId },
        orderBy: { sequence: 'asc' },
      });

      expect(events).toHaveLength(8);
      expect(events.map((e) => e.sequence)).toEqual(names.map((_, index) => BigInt(index + 1)));
    });

    it('counts independently per organization', async () => {
      const second = await seedOrg('Rift Valley Trading');

      await withTenant(org.organizationId, (tx) =>
        createCustomer(tx, org.context, { companyName: 'A One' }, 'ETB'),
      );
      await withTenant(second.organizationId, (tx) =>
        createCustomer(tx, second.context, { companyName: 'B One' }, 'ETB'),
      );

      const [a] = await owner.auditEvent.findMany({
        where: { organizationId: org.organizationId },
      });
      const [b] = await owner.auditEvent.findMany({
        where: { organizationId: second.organizationId },
      });

      expect(a?.sequence).toBe(1n);
      expect(b?.sequence).toBe(1n);
    });
  });

  describe('redaction', () => {
    it('never stores a credential, whatever the caller passes', async () => {
      await withTenant(org.organizationId, (tx) =>
        recordAudit(tx, org.context, {
          action: 'user.updated',
          entityType: 'user',
          entityId: org.userId,
          newState: {
            fullName: 'Meron Tesfaye',
            passwordHash: 'scrypt$32768$8$1$secret',
            nested: { token: 'should-not-persist' },
          },
        }),
      );

      const [event] = await owner.auditEvent.findMany({ where: { action: 'user.updated' } });
      const state = event?.newState as Record<string, unknown>;

      expect(state.fullName).toBe('Meron Tesfaye');
      expect(state.passwordHash).toBe('[redacted]');
      expect((state.nested as Record<string, unknown>).token).toBe('[redacted]');
    });

    it('serialises bigint money values without losing precision', async () => {
      await withTenant(org.organizationId, (tx) =>
        recordAudit(tx, org.context, {
          action: 'quotation.drafted',
          entityType: 'quotation',
          entityId: org.userId,
          newState: { totalMinor: 10_000_000_000_000_01n },
        }),
      );

      const [event] = await owner.auditEvent.findMany({ where: { action: 'quotation.drafted' } });
      const state = event?.newState as Record<string, unknown>;
      expect(state.totalMinor).toBe('10000000000000.01'.replace('.', ''));
    });
  });

  describe('append-only', () => {
    it('refuses an update or delete from the application role', async () => {
      await withTenant(org.organizationId, (tx) =>
        createCustomer(tx, org.context, { companyName: 'ABC Construction' }, 'ETB'),
      );

      await expect(
        withTenant(org.organizationId, (tx) =>
          tx.auditEvent.updateMany({ data: { action: 'rewritten' } }),
        ),
      ).rejects.toThrow();

      await expect(
        withTenant(org.organizationId, (tx) => tx.auditEvent.deleteMany({})),
      ).rejects.toThrow();
    });
  });
});
