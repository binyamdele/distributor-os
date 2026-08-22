import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';

/**
 * The one place physical stock changes, and the history that explains it.
 *
 * Phase 1 recorded manual corrections in `stock_adjustments`; Phase 6 recorded fulfilment
 * consumption only in the audit log. Both were durable, and neither could answer the question a
 * distributor actually asks when the numbers look wrong:
 *
 *     Why did Rebar 12mm decrease by 40?
 *
 * Phase 7 makes every physical stock change land in one ledger with the event that caused it
 * attached, so the answer is a row rather than a reconstruction. The table is Phase 1's, renamed
 * and widened — two competing stock-mutation paths would be worse than one that had to grow.
 *
 * What this is **not**: an accounting ledger, and not event sourcing. `product.available_stock`
 * remains the authority; this is the history that explains it, and a test asserts the two agree
 * from a known baseline rather than the ledger being replayed to produce the figure.
 */

export const MOVEMENT_TYPES = [
  'MANUAL_ADJUSTMENT',
  'FULFILLMENT_CONSUMPTION',
  'DISCREPANCY_RECONCILIATION',
  'RETURN_RESTOCK',
  'OTHER',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface MovementInput {
  readonly productId: string;
  readonly movementType: MovementType;
  /** Signed. Positive is a receipt, negative is a removal. Never zero. */
  readonly delta: number;
  /** The product's `available_stock` after this movement, read inside the same lock. */
  readonly stockAfter: number;
  readonly reason: string;
  readonly relatedOrderId?: string | null;
  readonly relatedReservationId?: string | null;
  readonly relatedDiscrepancyId?: string | null;
  readonly relatedReturnId?: string | null;
}

/**
 * Records one physical stock movement.
 *
 * Takes a transaction handle rather than a client, so a movement cannot be committed without the
 * stock change it describes, and cannot survive one that rolled back — the same reasoning as
 * `recordAudit`.
 *
 * `stockAfter` is passed in rather than read here, because the caller holds the product row lock
 * and has already computed it. Re-reading would be a second query returning the same number, or
 * — worse, if the lock were ever dropped — a different one.
 */
export async function recordMovement(
  tx: TenantTransaction,
  context: ActorContext,
  input: MovementInput,
): Promise<void> {
  if (input.delta === 0) {
    // Guarded here as well as by a CHECK, so the refusal names the caller rather than surfacing
    // as a constraint violation three frames away.
    throw new Error('an inventory movement must move a non-zero quantity');
  }

  await tx.inventoryMovement.create({
    data: {
      organizationId: context.organizationId,
      productId: input.productId,
      movementType: input.movementType,
      delta: input.delta,
      stockAfter: input.stockAfter,
      reason: input.reason,
      relatedOrderId: input.relatedOrderId ?? null,
      relatedReservationId: input.relatedReservationId ?? null,
      relatedDiscrepancyId: input.relatedDiscrepancyId ?? null,
      relatedReturnId: input.relatedReturnId ?? null,
      actorId: context.userId,
    },
  });
}

export interface MovementRow {
  readonly id: string;
  readonly movementType: MovementType;
  readonly delta: number;
  readonly stockAfter: number;
  readonly reason: string;
  readonly relatedOrderId: string | null;
  readonly relatedDiscrepancyId: string | null;
  readonly relatedReturnId: string | null;
  readonly createdAt: Date;
}

/** The movement history for one product, newest first. */
export async function movementsForProduct(
  tx: TenantTransaction,
  productId: string,
  limit = 100,
): Promise<MovementRow[]> {
  const rows = await tx.inventoryMovement.findMany({
    where: { productId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    movementType: row.movementType as MovementType,
    delta: row.delta,
    stockAfter: row.stockAfter,
    reason: row.reason,
    relatedOrderId: row.relatedOrderId,
    relatedDiscrepancyId: row.relatedDiscrepancyId,
    relatedReturnId: row.relatedReturnId,
    createdAt: row.createdAt,
  }));
}

/**
 * Whether the ledger explains the product's current figure.
 *
 * Walks forward from the oldest movement's implied opening balance and checks that the deltas
 * land on `available_stock`. Deliberately a *check* rather than the source of the figure: the
 * product row stays the authority, and this asserts the history is consistent with it.
 *
 * Returns null when there is nothing to check — a product nobody has ever moved.
 */
export async function reconcileLedger(
  tx: TenantTransaction,
  productId: string,
): Promise<{ openingBalance: number; expected: number; actual: number; agrees: boolean } | null> {
  const movements = await tx.inventoryMovement.findMany({
    where: { productId },
    orderBy: { createdAt: 'asc' },
    select: { delta: true, stockAfter: true },
  });
  if (movements.length === 0) return null;

  const product = await tx.product.findFirst({
    where: { id: productId },
    select: { availableStock: true },
  });
  if (!product) return null;

  // The balance before the first recorded movement. Movements began partway through this
  // product's life in any real deployment, so the baseline is derived rather than assumed zero.
  const first = movements[0]!;
  const openingBalance = first.stockAfter - first.delta;
  const expected = movements.reduce((sum, movement) => sum + movement.delta, openingBalance);

  return {
    openingBalance,
    expected,
    actual: product.availableStock,
    agrees: expected === product.availableStock,
  };
}
