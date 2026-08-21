import 'server-only';
import type { TenantTransaction } from '@/platform/db';

/**
 * Document numbering.
 *
 * Q-000001 for quotations, SO-000001 for sales orders in Phase 4. Two properties matter and
 * both are properties of the SQL rather than of the calling code:
 *
 *   1. **Never a duplicate.** Two salespeople clicking at the same moment must not receive the
 *      same number. The allocation is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 *      statement, so the read and the write are one atomic operation holding a row lock for
 *      their duration. There is no window between deciding a number and claiming it.
 *
 *   2. **Never derived from a count.** `count(*) + 1` is the obvious implementation and it is
 *      wrong twice over: it races, and it reuses numbers after a deletion, so two different
 *      documents can carry the same number months apart. Timestamps and client-generated ids
 *      fail differently and just as badly.
 *
 * Gaps are possible — a transaction that allocates a number and then rolls back consumes it.
 * That is the correct trade: a gap is a cosmetic oddity, a duplicate is a commercial dispute.
 */

export type SequenceKind = 'QUOTATION' | 'ORDER' | 'WAREHOUSE_TASK' | 'DELIVERY';

const PREFIX: Readonly<Record<SequenceKind, string>> = {
  QUOTATION: 'Q',
  ORDER: 'SO',
  // Phase 6. A picker calls out "WT-000042" across a yard; an order id does not survive that.
  WAREHOUSE_TASK: 'WT',
  DELIVERY: 'DL',
};

/** Six digits, widening beyond that rather than wrapping. Q-000001 … Q-999999 … Q-1000000. */
export function formatDocumentNumber(kind: SequenceKind, value: bigint): string {
  return `${PREFIX[kind]}-${value.toString().padStart(6, '0')}`;
}

/**
 * Allocates the next number for this organization.
 *
 * Must be called inside a `withTenant` transaction. `organization_id` is written into the
 * statement explicitly because raw SQL bypasses the Prisma scoping extension; RLS still stands
 * behind it, so a mismatched organization would be refused by the database as well.
 */
export async function allocateDocumentNumber(
  tx: TenantTransaction,
  organizationId: string,
  kind: SequenceKind,
): Promise<string> {
  const rows = await tx.$queryRaw<{ allocated: bigint }[]>`
    INSERT INTO number_sequences (id, organization_id, kind, next_value)
    VALUES (gen_random_uuid(), ${organizationId}::uuid, ${kind}::"SequenceKind", 2)
    ON CONFLICT (organization_id, kind)
    DO UPDATE SET next_value = number_sequences.next_value + 1
    RETURNING next_value - 1 AS allocated
  `;

  const allocated = rows[0]?.allocated;
  if (allocated === undefined) {
    throw new Error(`failed to allocate a ${kind} number for organization ${organizationId}`);
  }

  return formatDocumentNumber(kind, BigInt(allocated));
}
