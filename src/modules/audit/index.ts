import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import { type ActorContext, actorTypeOf } from '@/platform/context';

/**
 * The audit log.
 *
 * Two properties make it worth having, and both are structural rather than procedural:
 *
 *   1. **It shares the transaction with the change it records.** `recordAudit` takes a
 *      transaction handle, not a client, so there is no way to commit a mutation whose audit
 *      row failed to write — and no way to leave an audit row behind for a mutation that
 *      rolled back.
 *
 *   2. **Ordering is per-organization and gapless.** `sequence` is allocated under a
 *      transaction-scoped advisory lock. Timestamps cannot promise this: two events in the
 *      same millisecond have no defined order, and a clock adjustment can reorder history.
 *      "What happened to quotation Q-000042, in order" is a question the log must answer
 *      exactly.
 */

export interface AuditInput {
  /** Dotted verb: "customer.created", "product.stock_adjusted", "quotation.approved". */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly oldState?: unknown;
  readonly newState?: unknown;
  /** Set when the change passed through an approval gate. */
  readonly approvalStatus?: string | null;
  readonly aiInvolved?: boolean;
  /** Only meaningful when the action carried a computed confidence. Never a self-reported one. */
  readonly confidence?: number | null;
}

/**
 * Keys never written to the audit log, whatever the caller passes.
 *
 * A credential in an audit row is a credential in every backup and every export of that row.
 * Stripping is done here rather than at call sites because the call sites are the place it
 * will eventually be forgotten.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'tokenHash',
  'token_hash',
  'token',
  'sessionToken',
  'secret',
  'apiKey',
]);

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(inner);
  }
  return out;
}

async function nextSequence(tx: TenantTransaction, organizationId: string): Promise<bigint> {
  // Serialises sequence allocation per organization for the life of this transaction. Two
  // concurrent writers in the same organization queue; writers in different organizations
  // never contend with each other.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`audit:${organizationId}`}))`;

  const highest = await tx.auditEvent.aggregate({ _max: { sequence: true } });
  return (highest._max.sequence ?? 0n) + 1n;
}

export async function recordAudit(
  tx: TenantTransaction,
  context: ActorContext,
  input: AuditInput,
): Promise<void> {
  const sequence = await nextSequence(tx, context.organizationId);

  await tx.auditEvent.create({
    data: {
      // Written explicitly rather than left to the extension to inject. The extension still
      // checks it — a value that disagrees with the session's organization throws
      // CrossTenantAccessError — so being explicit costs nothing and keeps Prisma's types honest.
      organizationId: context.organizationId,
      sequence,
      actorType: actorTypeOf(context),
      actorId: context.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      oldState: redact(input.oldState) as never,
      newState: redact(input.newState) as never,
      source: context.source,
      approvalStatus: input.approvalStatus ?? null,
      aiInvolved: input.aiInvolved ?? false,
      confidence: input.confidence ?? null,
    },
  });
}

export interface AuditEntry {
  readonly id: string;
  readonly sequence: bigint;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly source: string;
  readonly aiInvolved: boolean;
  readonly createdAt: Date;
  readonly oldState: unknown;
  readonly newState: unknown;
}

/** The history of one entity, oldest first — the lifecycle view the brief asks for. */
export async function auditTrailFor(
  tx: TenantTransaction,
  entityType: string,
  entityId: string,
): Promise<AuditEntry[]> {
  return tx.auditEvent.findMany({
    where: { entityType, entityId },
    orderBy: { sequence: 'asc' },
  }) as unknown as Promise<AuditEntry[]>;
}

/** The most recent activity across the organization, newest first. */
export async function recentAudit(tx: TenantTransaction, limit = 50): Promise<AuditEntry[]> {
  return tx.auditEvent.findMany({
    orderBy: { sequence: 'desc' },
    take: limit,
  }) as unknown as Promise<AuditEntry[]>;
}
