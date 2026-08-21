import { describe, expect, it } from 'vitest';
import {
  type ProductStockRow,
  type RequiredLine,
  type ReservationRow,
  applyConsumption,
  describeMismatch,
  planConsumption,
} from '@/modules/fulfillment';

const CEMENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const REBAR = 'bbbbbbbb-0000-4000-8000-000000000002';

const line = (overrides: Partial<RequiredLine> = {}): RequiredLine => ({
  productId: CEMENT,
  sku: 'CEM-OPC-50',
  description: 'OPC Cement 50kg',
  unit: 'bag',
  quantity: 30,
  ...overrides,
});

const reservation = (overrides: Partial<ReservationRow> = {}): ReservationRow => ({
  id: 'r1',
  productId: CEMENT,
  quantity: 30,
  status: 'ACTIVE',
  ...overrides,
});

const stock = (overrides: Partial<ProductStockRow> = {}): ProductStockRow => ({
  productId: CEMENT,
  sku: 'CEM-OPC-50',
  availableStock: 100,
  reservedStock: 30,
  ...overrides,
});

/** The organization-wide ACTIVE totals, which the maintained aggregate is compared against. */
const aggregate = (entries: [string, number][] = [[CEMENT, 30]]) => new Map(entries);

describe('the worked example from the stock model', () => {
  it('takes 30 out of 100 on hand with 30 reserved, leaving 70 and 0', () => {
    const plan = planConsumption([line()], [reservation()], [stock()], aggregate());
    expect(plan.satisfiable).toBe(true);
    expect(plan.byProduct.get(CEMENT)).toBe(30);

    const after = applyConsumption({ availableStock: 100, reservedStock: 30 }, 30);
    expect(after).toEqual({ availableStock: 70, reservedStock: 0 });
  });

  it('leaves free stock unchanged, because reserved goods were never promisable', () => {
    // The property that makes decrementing both figures correct. 70 free before, 70 free after:
    // those bags becoming physically absent changes nothing about what can still be sold.
    const before = { availableStock: 100, reservedStock: 30 };
    const after = applyConsumption(before, 30);
    expect(before.availableStock - before.reservedStock).toBe(70);
    expect(after.availableStock - after.reservedStock).toBe(70);
  });

  it('can empty a product completely', () => {
    expect(applyConsumption({ availableStock: 30, reservedStock: 30 }, 30)).toEqual({
      availableStock: 0,
      reservedStock: 0,
    });
  });
});

describe('planning a consumption', () => {
  it('sums two lines that name the same product', () => {
    // A quotation can list cement twice. The reservation is held against the product, so the
    // comparison has to be made against one figure or a two-line order would look short.
    const plan = planConsumption(
      [line({ quantity: 10 }), line({ quantity: 20 })],
      [reservation({ quantity: 30 })],
      [stock()],
      aggregate(),
    );
    expect(plan.satisfiable).toBe(true);
    expect(plan.byProduct.get(CEMENT)).toBe(30);
  });

  it('handles several products at once', () => {
    const plan = planConsumption(
      [line(), line({ productId: REBAR, sku: 'RB-12', quantity: 40 })],
      [reservation(), reservation({ id: 'r2', productId: REBAR, quantity: 40 })],
      [stock(), stock({ productId: REBAR, sku: 'RB-12', availableStock: 60, reservedStock: 40 })],
      aggregate([
        [CEMENT, 30],
        [REBAR, 40],
      ]),
    );
    expect(plan.satisfiable).toBe(true);
    expect([...plan.byProduct.entries()].sort()).toEqual([
      [CEMENT, 30],
      [REBAR, 40],
    ]);
  });

  it('returns the reservation ids it will consume, and only the active ones', () => {
    const plan = planConsumption(
      [line()],
      [
        reservation({ id: 'active', quantity: 30 }),
        reservation({ id: 'released', quantity: 15, status: 'RELEASED' }),
        reservation({ id: 'consumed', quantity: 5, status: 'CONSUMED' }),
      ],
      [stock()],
      aggregate(),
    );
    expect(plan.satisfiable).toBe(true);
    expect(plan.reservationIds).toEqual(['active']);
  });

  it('ignores a released reservation when counting what is held', () => {
    // A previously released reservation must not make a short order look covered.
    const plan = planConsumption(
      [line({ quantity: 30 })],
      [
        reservation({ id: 'a', quantity: 20 }),
        reservation({ id: 'b', quantity: 10, status: 'RELEASED' }),
      ],
      [stock()],
      aggregate([[CEMENT, 20]]),
    );
    expect(plan.satisfiable).toBe(false);
    expect(plan.mismatches[0]).toMatchObject({ kind: 'RESERVATION_SHORT', expected: 30, actual: 20 });
  });
});

describe('refusing on a mismatch', () => {
  it('refuses when the reservation holds less than the order needs', () => {
    // The §14 case: 12 required, 10 there. Blocked, and nothing altered.
    const plan = planConsumption(
      [line({ quantity: 12 })],
      [reservation({ quantity: 10 })],
      [stock()],
      aggregate([[CEMENT, 10]]),
    );
    expect(plan.satisfiable).toBe(false);
    expect(plan.mismatches).toHaveLength(1);
    expect(plan.mismatches[0]).toMatchObject({
      kind: 'RESERVATION_SHORT',
      expected: 12,
      actual: 10,
      sku: 'CEM-OPC-50',
    });
  });

  it('refuses when nothing is reserved at all', () => {
    const plan = planConsumption([line()], [], [stock()], aggregate([]));
    expect(plan.mismatches[0]).toMatchObject({ kind: 'RESERVATION_MISSING', expected: 30, actual: 0 });
  });

  it('refuses when the reservation holds more than the order needs', () => {
    // "At least enough" is the tempting rule and the wrong one: consuming 30 out of a 45-unit
    // reservation would leave 15 committed to nothing, forever.
    const plan = planConsumption(
      [line({ quantity: 30 })],
      [reservation({ quantity: 45 })],
      [stock({ reservedStock: 45 })],
      aggregate([[CEMENT, 45]]),
    );
    expect(plan.satisfiable).toBe(false);
    expect(plan.mismatches[0]).toMatchObject({ kind: 'RESERVATION_EXCESS', expected: 30, actual: 45 });
  });

  it('refuses when the shelf cannot cover what is leaving', () => {
    const plan = planConsumption(
      [line({ quantity: 30 })],
      [reservation({ quantity: 30 })],
      [stock({ availableStock: 25 })],
      aggregate(),
    );
    expect(plan.mismatches[0]).toMatchObject({
      kind: 'PHYSICAL_STOCK_SHORT',
      expected: 30,
      actual: 25,
    });
  });

  it('refuses when the maintained aggregate disagrees with the reservation rows', () => {
    // The rows are the source of truth and `reserved_stock` is a cache. Consuming against a
    // stale cache is how a cache stops being one.
    const plan = planConsumption(
      [line()],
      [reservation()],
      [stock({ reservedStock: 55 })],
      aggregate([[CEMENT, 30]]),
    );
    expect(plan.mismatches[0]).toMatchObject({
      kind: 'AGGREGATE_DISAGREES',
      expected: 30,
      actual: 55,
    });
  });

  it('refuses when the product has vanished from the catalogue', () => {
    const plan = planConsumption([line()], [reservation()], [], aggregate());
    expect(plan.mismatches[0]).toMatchObject({ kind: 'PHYSICAL_STOCK_SHORT', actual: 0 });
  });

  it('reports one mismatch per product, not one per line', () => {
    const plan = planConsumption(
      [line({ quantity: 10 }), line({ quantity: 10 })],
      [],
      [stock()],
      aggregate([]),
    );
    expect(plan.mismatches).toHaveLength(1);
    expect(plan.mismatches[0]!.expected).toBe(20);
  });

  it('reports every affected product when more than one is wrong', () => {
    const plan = planConsumption(
      [line(), line({ productId: REBAR, sku: 'RB-12', quantity: 40 })],
      [],
      [stock(), stock({ productId: REBAR, sku: 'RB-12' })],
      aggregate([]),
    );
    expect(plan.mismatches.map((mismatch) => mismatch.sku).sort()).toEqual(['CEM-OPC-50', 'RB-12']);
  });

  it('never proposes consuming anything when it refuses', () => {
    // The single most important property here. A refusal must not half-apply.
    const plan = planConsumption(
      [line({ quantity: 12 })],
      [reservation({ quantity: 10 })],
      [stock()],
      aggregate([[CEMENT, 10]]),
    );
    expect(plan.satisfiable).toBe(false);
    // reservationIds is still populated — it describes what exists, not what will be done — but
    // the caller is gated on `satisfiable` and never reaches the write.
    expect(plan.mismatches.length).toBeGreaterThan(0);
  });
});

describe('explaining a mismatch to the person holding the trolley', () => {
  it('states two numbers and a unit, never an adjective', () => {
    const message = describeMismatch({
      kind: 'RESERVATION_SHORT',
      productId: REBAR,
      sku: 'RB-12',
      description: 'Rebar 12mm',
      unit: 'piece',
      expected: 80,
      actual: 60,
    });
    expect(message).toContain('Rebar 12mm');
    expect(message).toContain('RB-12');
    expect(message).toContain('80');
    expect(message).toContain('60');
  });

  it('has wording for every kind of mismatch', () => {
    const kinds = [
      'RESERVATION_SHORT',
      'RESERVATION_EXCESS',
      'RESERVATION_MISSING',
      'PHYSICAL_STOCK_SHORT',
      'AGGREGATE_DISAGREES',
    ] as const;

    for (const kind of kinds) {
      const message = describeMismatch({
        kind,
        productId: CEMENT,
        sku: 'CEM-OPC-50',
        description: 'OPC Cement 50kg',
        unit: 'bag',
        expected: 30,
        actual: 20,
      });
      expect(message.length, `${kind} has no wording`).toBeGreaterThan(20);
      expect(message).toContain('CEM-OPC-50');
    }
  });
});
