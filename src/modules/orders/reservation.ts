/**
 * Reservation arithmetic and policy.
 *
 * Pure, so the rule that decides whether a distributor can promise goods is enumerable in a
 * unit test rather than inferred from a transaction.
 *
 * ## The stock invariant
 *
 * Phase 1 established the meaning and Phase 4 does not change it:
 *
 *     availableStock   on hand, physically in the yard
 *     reservedStock    committed to open sales orders
 *     freeStock        availableStock − reservedStock, what may still be promised
 *
 * A reservation raises `reservedStock`; it never touches `availableStock`. Goods do not leave
 * the yard when an order is raised, and pretending otherwise would make the stock figure the
 * warehouse counts disagree with the one the system shows.
 *
 * `stock_reservations` rows are the source of truth. `product.reserved_stock` is an aggregate
 * of the ACTIVE rows, written in the same transaction, and
 * `tests/integration/orders.test.ts` asserts the two agree after every operation.
 */

export interface ReservationRequest {
  readonly productId: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly quantity: number;
}

export interface ProductStock {
  readonly productId: string;
  readonly availableStock: number;
  readonly reservedStock: number;
}

export interface LineShortfall {
  readonly productId: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly requested: number;
  readonly availableToReserve: number;
  readonly shortfall: number;
}

export interface ReservationPlan {
  readonly satisfiable: boolean;
  readonly shortfalls: readonly LineShortfall[];
  /** Total to reserve per product, summed across lines that name the same product. */
  readonly byProduct: ReadonlyMap<string, number>;
}

export function freeToReserve(stock: ProductStock): number {
  return stock.availableStock - stock.reservedStock;
}

/**
 * Works out whether every requested line can be reserved in full.
 *
 * **All or nothing.** If any line is short, nothing is reserved — not the lines that would have
 * fitted, not a reduced quantity, not a backorder. Partial reservation looks helpful and is
 * not: it leaves an order that is neither fulfillable nor refused, and the salesperson finds out
 * at the warehouse door. Refusing with an exact shortfall gives them the conversation to have
 * with the customer.
 *
 * Quantities are summed per product first. Two lines naming the same product must be checked
 * against one stock figure, or a quotation with cement on two lines could reserve twice what
 * exists.
 */
export function planReservation(
  requests: readonly ReservationRequest[],
  stocks: readonly ProductStock[],
): ReservationPlan {
  const stockByProduct = new Map(stocks.map((stock) => [stock.productId, stock]));

  const byProduct = new Map<string, number>();
  for (const request of requests) {
    byProduct.set(request.productId, (byProduct.get(request.productId) ?? 0) + request.quantity);
  }

  // One shortfall entry per product, reported against the first line that named it.
  const reported = new Set<string>();
  const shortfalls: LineShortfall[] = [];

  for (const request of requests) {
    if (reported.has(request.productId)) continue;

    const stock = stockByProduct.get(request.productId);
    const availableToReserve = stock ? freeToReserve(stock) : 0;
    const wanted = byProduct.get(request.productId) ?? 0;

    if (wanted > availableToReserve) {
      reported.add(request.productId);
      shortfalls.push({
        productId: request.productId,
        sku: request.sku,
        description: request.description,
        unit: request.unit,
        requested: wanted,
        availableToReserve: Math.max(0, availableToReserve),
        shortfall: wanted - Math.max(0, availableToReserve),
      });
    }
  }

  return { satisfiable: shortfalls.length === 0, shortfalls, byProduct };
}

/**
 * The order in which product rows must be locked.
 *
 * Ascending product id, always — never the order the quotation happens to list them in. Two
 * orders sharing cement and rebar would otherwise take the two locks in opposite orders and
 * deadlock, and the failure would be intermittent and load-dependent, which is the worst kind
 * to diagnose.
 */
export function lockOrder(productIds: readonly string[]): string[] {
  return [...new Set(productIds)].sort();
}
