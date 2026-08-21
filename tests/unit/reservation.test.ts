import { describe, expect, it } from 'vitest';
import {
  type ProductStock,
  type ReservationRequest,
  freeToReserve,
  initialStatuses,
  lockOrder,
  planReservation,
} from '@/modules/orders';

function request(overrides: Partial<ReservationRequest> = {}): ReservationRequest {
  return {
    productId: 'product-cement',
    sku: 'CEM-OPC-50',
    description: 'OPC Cement 50kg',
    unit: 'bag',
    quantity: 100,
    ...overrides,
  };
}

function stock(overrides: Partial<ProductStock> = {}): ProductStock {
  return { productId: 'product-cement', availableStock: 500, reservedStock: 0, ...overrides };
}

describe('the stock invariant', () => {
  it('is on-hand minus reserved', () => {
    expect(freeToReserve({ productId: 'p', availableStock: 500, reservedStock: 120 })).toBe(380);
  });

  it('can be zero without being an error', () => {
    expect(freeToReserve({ productId: 'p', availableStock: 100, reservedStock: 100 })).toBe(0);
  });
});

describe('planning a reservation', () => {
  it('succeeds when every line fits', () => {
    const plan = planReservation([request()], [stock()]);
    expect(plan.satisfiable).toBe(true);
    expect(plan.shortfalls).toEqual([]);
    expect(plan.byProduct.get('product-cement')).toBe(100);
  });

  it('succeeds at exactly the available quantity', () => {
    const plan = planReservation(
      [request({ quantity: 380 })],
      [stock({ availableStock: 500, reservedStock: 120 })],
    );
    expect(plan.satisfiable).toBe(true);
  });

  it('fails one unit beyond it, with an exact shortfall', () => {
    const plan = planReservation(
      [request({ quantity: 381 })],
      [stock({ availableStock: 500, reservedStock: 120 })],
    );
    expect(plan.satisfiable).toBe(false);
    expect(plan.shortfalls[0]).toMatchObject({
      sku: 'CEM-OPC-50',
      requested: 381,
      availableToReserve: 380,
      shortfall: 1,
    });
  });

  it('counts stock already reserved by other orders', () => {
    // The whole point of the reserved figure: 500 on hand with 450 promised leaves 50 to sell.
    const plan = planReservation(
      [request({ quantity: 100 })],
      [stock({ availableStock: 500, reservedStock: 450 })],
    );
    expect(plan.satisfiable).toBe(false);
    expect(plan.shortfalls[0]?.availableToReserve).toBe(50);
    expect(plan.shortfalls[0]?.shortfall).toBe(50);
  });

  it('sums two lines naming the same product before checking', () => {
    // A quotation with cement on two lines must be checked against one stock figure, or it
    // would reserve twice what exists.
    const plan = planReservation(
      [request({ quantity: 300 }), request({ quantity: 300 })],
      [stock({ availableStock: 500 })],
    );
    expect(plan.satisfiable).toBe(false);
    expect(plan.shortfalls).toHaveLength(1);
    expect(plan.shortfalls[0]?.requested).toBe(600);
    expect(plan.shortfalls[0]?.shortfall).toBe(100);
  });

  it('adds up per product in the plan', () => {
    const plan = planReservation(
      [request({ quantity: 200 }), request({ quantity: 150 })],
      [stock({ availableStock: 500 })],
    );
    expect(plan.byProduct.get('product-cement')).toBe(350);
  });

  it('reports every short product, not only the first', () => {
    const plan = planReservation(
      [
        request({ productId: 'a', sku: 'A', quantity: 10 }),
        request({ productId: 'b', sku: 'B', quantity: 10 }),
      ],
      [
        { productId: 'a', availableStock: 5, reservedStock: 0 },
        { productId: 'b', availableStock: 1, reservedStock: 0 },
      ],
    );
    expect(plan.shortfalls.map((shortfall) => shortfall.sku)).toEqual(['A', 'B']);
  });

  it('treats a missing product as nothing available', () => {
    const plan = planReservation([request()], []);
    expect(plan.satisfiable).toBe(false);
    expect(plan.shortfalls[0]?.availableToReserve).toBe(0);
  });

  it('never reports a negative availability', () => {
    // On-hand below reserved should not surface as "minus forty available".
    const plan = planReservation(
      [request({ quantity: 10 })],
      [stock({ availableStock: 10, reservedStock: 50 })],
    );
    expect(plan.shortfalls[0]?.availableToReserve).toBe(0);
    expect(plan.shortfalls[0]?.shortfall).toBe(10);
  });

  it('is all or nothing: a short line does not shrink the others', () => {
    // The plan either satisfies everything or nothing. No line is quietly reduced.
    const plan = planReservation(
      [
        request({ productId: 'a', sku: 'A', quantity: 5 }),
        request({ productId: 'b', sku: 'B', quantity: 99 }),
      ],
      [
        { productId: 'a', availableStock: 100, reservedStock: 0 },
        { productId: 'b', availableStock: 10, reservedStock: 0 },
      ],
    );
    expect(plan.satisfiable).toBe(false);
    expect(plan.byProduct.get('a')).toBe(5);
    expect(plan.byProduct.get('b')).toBe(99);
  });
});

describe('lock ordering', () => {
  it('sorts ids ascending', () => {
    expect(lockOrder(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates, so a product on two lines is locked once', () => {
    expect(lockOrder(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('gives the same order whatever the quotation order was', () => {
    // The deadlock guarantee: two orders sharing products take the locks in the same sequence.
    const forward = lockOrder(['cement', 'rebar']);
    const reversed = lockOrder(['rebar', 'cement']);
    expect(forward).toEqual(reversed);
  });

  it('handles an empty list', () => {
    expect(lockOrder([])).toEqual([]);
  });
});

describe('the initial order position', () => {
  it('leaves a cash order unpaid and not ready', () => {
    // The load-bearing case. Reserving stock must not imply the warehouse may release goods;
    // that unlock waits for finance to confirm payment in Phase 5.
    expect(initialStatuses('CASH')).toEqual({
      paymentStatus: 'UNPAID',
      fulfillmentStatus: 'NOT_READY',
    });
  });

  it('lets a credit order be prepared, with nothing owed yet', () => {
    expect(initialStatuses('CREDIT')).toEqual({
      paymentStatus: 'NOT_REQUIRED_YET',
      fulfillmentStatus: 'READY',
    });
  });

  it('never starts an order as paid', () => {
    for (const type of ['CASH', 'CREDIT'] as const) {
      expect(initialStatuses(type).paymentStatus).not.toBe('PAID');
    }
  });
});
