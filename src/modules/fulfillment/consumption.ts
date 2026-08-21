/**
 * Consumption arithmetic.
 *
 * Pure. The rule that decides whether goods may be signed out of a yard is worth being able to
 * enumerate in a unit test rather than reconstruct from a transaction log after an argument.
 *
 * ## What consumption does to the two stock figures
 *
 * Phase 1 defined them and Phase 4 kept them:
 *
 *     availableStock   on hand, physically in the yard
 *     reservedStock    the portion committed to open sales orders
 *     free             availableStock − reservedStock, what may still be promised
 *
 * Raising an order moves nothing physical: it raises `reservedStock` only, because the bags are
 * still on the floor. Fulfilment is the opposite moment — the bags leave — so consumption
 * decrements **both**:
 *
 *     before   available 100   reserved 30    free 70
 *     ship 30
 *     after    available  70   reserved  0    free 70
 *
 * `free` is unchanged, which is the point: those 30 bags were never promisable to anyone else,
 * so nothing about them becoming physically absent changes what can still be sold. A version
 * that decremented only `availableStock` would silently destroy 30 units of sellable stock;
 * one that decremented only `reservedStock` would offer goods that are on a lorry.
 */

export interface ReservationRow {
  readonly id: string;
  readonly productId: string;
  readonly quantity: number;
  readonly status: string;
}

export interface RequiredLine {
  readonly productId: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly quantity: number;
}

export interface ProductStockRow {
  readonly productId: string;
  readonly sku: string;
  readonly availableStock: number;
  readonly reservedStock: number;
}

export type MismatchKind =
  | 'RESERVATION_SHORT'
  | 'RESERVATION_EXCESS'
  | 'RESERVATION_MISSING'
  | 'PHYSICAL_STOCK_SHORT'
  | 'AGGREGATE_DISAGREES';

export interface ConsumptionMismatch {
  readonly kind: MismatchKind;
  readonly productId: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly expected: number;
  readonly actual: number;
}

export interface ConsumptionPlan {
  readonly satisfiable: boolean;
  readonly mismatches: readonly ConsumptionMismatch[];
  /** Quantity to remove from each product, summed across lines naming the same one. */
  readonly byProduct: ReadonlyMap<string, number>;
  /** The reservation rows this task owns and will mark CONSUMED. */
  readonly reservationIds: readonly string[];
}

/**
 * Works out whether this task's reservations still exactly cover what it must hand over.
 *
 * Three separate things are checked, and none of them is repaired:
 *
 *   1. **The task's own ACTIVE reservations equal the required quantity, per product.** Not
 *      "at least" — exactly. A reservation holding more than the order needs is as much a sign
 *      of a broken invariant as one holding less, and quietly consuming the required amount out
 *      of an oversized reservation would leave the remainder committed to nothing forever.
 *   2. **Physical stock covers what is leaving.** It should, by construction; if it does not,
 *      the yard and the system disagree and a person has to look.
 *   3. **The maintained `reserved_stock` aggregate agrees with the ACTIVE rows.** The rows are
 *      the source of truth and the column is a cache; consuming against a stale cache is how
 *      a cache stops being one.
 *
 * **Nothing here corrects anything.** A mismatch during fulfilment is an invariant violation,
 * and the one thing that must not happen is for a shipping operation to quietly adjust stock to
 * make itself succeed. Adjusting stock is a separate, separately audited act performed by a
 * person who has counted the shelf — see `adjustStock` in the catalogue module, which stays
 * deliberately unconnected to this path. A fulfilment that repairs its own preconditions is a
 * fulfilment that can never be shown to have been correct.
 */
export function planConsumption(
  required: readonly RequiredLine[],
  reservations: readonly ReservationRow[],
  stocks: readonly ProductStockRow[],
  /** ACTIVE reservation totals per product across the *whole* organization, for check 3. */
  organizationActiveByProduct: ReadonlyMap<string, number>,
): ConsumptionPlan {
  const mismatches: ConsumptionMismatch[] = [];

  const requiredByProduct = new Map<string, number>();
  const lineByProduct = new Map<string, RequiredLine>();
  for (const line of required) {
    requiredByProduct.set(line.productId, (requiredByProduct.get(line.productId) ?? 0) + line.quantity);
    if (!lineByProduct.has(line.productId)) lineByProduct.set(line.productId, line);
  }

  const active = reservations.filter((reservation) => reservation.status === 'ACTIVE');
  const activeByProduct = new Map<string, number>();
  for (const reservation of active) {
    activeByProduct.set(
      reservation.productId,
      (activeByProduct.get(reservation.productId) ?? 0) + reservation.quantity,
    );
  }

  const stockByProduct = new Map(stocks.map((stock) => [stock.productId, stock]));

  for (const [productId, wanted] of requiredByProduct) {
    const line = lineByProduct.get(productId)!;
    const held = activeByProduct.get(productId) ?? 0;
    const describe = (kind: MismatchKind, expected: number, actual: number) =>
      mismatches.push({
        kind,
        productId,
        sku: line.sku,
        description: line.description,
        unit: line.unit,
        expected,
        actual,
      });

    if (held === 0) {
      describe('RESERVATION_MISSING', wanted, 0);
      continue;
    }
    if (held < wanted) {
      describe('RESERVATION_SHORT', wanted, held);
      continue;
    }
    if (held > wanted) {
      describe('RESERVATION_EXCESS', wanted, held);
      continue;
    }

    const stock = stockByProduct.get(productId);
    if (!stock || stock.availableStock < wanted) {
      describe('PHYSICAL_STOCK_SHORT', wanted, stock?.availableStock ?? 0);
      continue;
    }

    // The cache against the rows. Compared organization-wide rather than per order, because
    // that is the invariant `product.reserved_stock` actually claims.
    const aggregate = organizationActiveByProduct.get(productId) ?? 0;
    if (stock.reservedStock !== aggregate) {
      describe('AGGREGATE_DISAGREES', aggregate, stock.reservedStock);
    }
  }

  return {
    satisfiable: mismatches.length === 0,
    mismatches,
    byProduct: requiredByProduct,
    reservationIds: active.map((reservation) => reservation.id),
  };
}

/** The stock figures a product carries after goods leave. Never a float, never negative. */
export function applyConsumption(
  stock: Pick<ProductStockRow, 'availableStock' | 'reservedStock'>,
  quantity: number,
): { availableStock: number; reservedStock: number } {
  return {
    availableStock: stock.availableStock - quantity,
    reservedStock: stock.reservedStock - quantity,
  };
}

/** Human-readable, and deliberately two numbers rather than an adjective. */
export function describeMismatch(mismatch: ConsumptionMismatch): string {
  switch (mismatch.kind) {
    case 'RESERVATION_MISSING':
      return `${mismatch.description} (${mismatch.sku}): nothing is reserved, but ${mismatch.expected} ${mismatch.unit} is required.`;
    case 'RESERVATION_SHORT':
      return `${mismatch.description} (${mismatch.sku}): ${mismatch.expected} ${mismatch.unit} required, ${mismatch.actual} actively reserved.`;
    case 'RESERVATION_EXCESS':
      return `${mismatch.description} (${mismatch.sku}): ${mismatch.expected} ${mismatch.unit} required, but ${mismatch.actual} is reserved.`;
    case 'PHYSICAL_STOCK_SHORT':
      return `${mismatch.description} (${mismatch.sku}): ${mismatch.expected} ${mismatch.unit} to hand over, ${mismatch.actual} recorded on hand.`;
    case 'AGGREGATE_DISAGREES':
      return `${mismatch.description} (${mismatch.sku}): the reserved total on the product says ${mismatch.actual}, the reservations add up to ${mismatch.expected}.`;
  }
}
