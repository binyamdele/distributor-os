import { describe, expect, it } from 'vitest';
import {
  BASIS_POINTS,
  type PricedLineInput,
  calculateTotals,
  deepestDiscountBp,
  effectiveUnitPrice,
  linesBelowFloor,
  priceLine,
  reconciles,
} from '@/modules/quotations/pricing';
import { toDecimalString } from '@/platform/money';

const ETB = 'ETB';
const etb = (major: number, minor = 0): bigint => BigInt(major) * 100n + BigInt(minor);

function line(overrides: Partial<PricedLineInput> = {}): PricedLineInput {
  return {
    quantity: 1,
    listUnitPriceMinor: etb(100),
    quotedUnitPriceMinor: etb(100),
    discountBp: 0,
    taxRateBp: 1500,
    ...overrides,
  };
}

describe('line pricing', () => {
  it('follows the documented order exactly', () => {
    // 80 pieces of Rebar 12mm at ETB 1,420.00, 2.5% off, 15% VAT.
    const priced = priceLine(
      line({ quantity: 80, listUnitPriceMinor: etb(1_420), quotedUnitPriceMinor: etb(1_420), discountBp: 250 }),
      ETB,
    );

    // gross = 80 × 1,420.00 = 113,600.00
    expect(toDecimalString({ amountMinor: priced.lineSubtotalMinor, currency: ETB })).toBe('113600.00');
    // discount = half-up(113,600.00 × 250 / 10,000) = 2,840.00
    expect(toDecimalString({ amountMinor: priced.lineDiscountMinor, currency: ETB })).toBe('2840.00');
    // taxable = 110,760.00
    expect(toDecimalString({ amountMinor: priced.taxableAmountMinor, currency: ETB })).toBe('110760.00');
    // tax = half-up(110,760.00 × 1500 / 10,000) = 16,614.00
    expect(toDecimalString({ amountMinor: priced.taxMinor, currency: ETB })).toBe('16614.00');
    // total = 127,374.00
    expect(toDecimalString({ amountMinor: priced.lineTotalMinor, currency: ETB })).toBe('127374.00');
  });

  it('rounds half-up at the line, not at the unit', () => {
    // 3 × ETB 0.07 = 0.21, 10% off = 0.021 -> 0.02 half-up. Discounting the unit first would
    // give 0.07 - 0.007 -> 0.06 or 0.07 per unit and a line that does not reconcile.
    const priced = priceLine(
      line({ quantity: 3, listUnitPriceMinor: 7n, quotedUnitPriceMinor: 7n, discountBp: 1000, taxRateBp: 0 }),
      ETB,
    );
    expect(priced.lineSubtotalMinor).toBe(21n);
    expect(priced.lineDiscountMinor).toBe(2n);
    expect(priced.taxableAmountMinor).toBe(19n);
    expect(priced.lineTotalMinor).toBe(19n);
  });

  it('rounds a half santim away from zero', () => {
    // 0.10 at 15% is exactly 1.5 santim.
    const priced = priceLine(
      line({ quantity: 1, listUnitPriceMinor: 10n, quotedUnitPriceMinor: 10n, taxRateBp: 1500 }),
      ETB,
    );
    expect(priced.taxMinor).toBe(2n);
  });

  it('applies no discount when none is given', () => {
    const priced = priceLine(line({ quantity: 500, listUnitPriceMinor: etb(1_250), quotedUnitPriceMinor: etb(1_250) }), ETB);
    expect(priced.lineDiscountMinor).toBe(0n);
    expect(priced.taxableAmountMinor).toBe(priced.lineSubtotalMinor);
  });

  it('handles a full 100% discount without going negative', () => {
    const priced = priceLine(line({ quantity: 5, discountBp: BASIS_POINTS }), ETB);
    expect(priced.taxableAmountMinor).toBe(0n);
    expect(priced.taxMinor).toBe(0n);
    expect(priced.lineTotalMinor).toBe(0n);
  });

  it('refuses a fractional quantity rather than rounding it', () => {
    expect(() => priceLine(line({ quantity: 2.5 }), ETB)).toThrow(/whole number/);
  });

  it('refuses zero and negative quantities', () => {
    expect(() => priceLine(line({ quantity: 0 }), ETB)).toThrow();
    expect(() => priceLine(line({ quantity: -1 }), ETB)).toThrow();
  });

  it('refuses a discount outside 0 to 100 per cent', () => {
    expect(() => priceLine(line({ discountBp: -1 }), ETB)).toThrow();
    expect(() => priceLine(line({ discountBp: BASIS_POINTS + 1 }), ETB)).toThrow();
  });

  it('refuses a negative price', () => {
    expect(() => priceLine(line({ quotedUnitPriceMinor: -1n }), ETB)).toThrow(/negative/);
  });

  it('survives quantities and prices beyond float precision', () => {
    const priced = priceLine(
      line({ quantity: 200_000, listUnitPriceMinor: etb(99_999_999), quotedUnitPriceMinor: etb(99_999_999), taxRateBp: 0 }),
      ETB,
    );
    expect(priced.lineSubtotalMinor).toBe(200_000n * etb(99_999_999));
  });
});

describe('the effective unit price', () => {
  it('is the discounted unit price, for display', () => {
    expect(effectiveUnitPrice(etb(1_420), 250, ETB)).toBe(etb(1_384, 50));
  });

  it('equals the quoted price when there is no discount', () => {
    expect(effectiveUnitPrice(etb(1_420), 0, ETB)).toBe(etb(1_420));
  });

  it('is documented as display-only, and may not divide the line total exactly', () => {
    // 3 × 0.07 with 10% off: the line taxable is 19 santim, but 19/3 is not a whole santim.
    const priced = priceLine(
      line({ quantity: 3, listUnitPriceMinor: 7n, quotedUnitPriceMinor: 7n, discountBp: 1000, taxRateBp: 0 }),
      ETB,
    );
    expect(priced.effectiveUnitPriceMinor * 3n).not.toBe(priced.taxableAmountMinor);
    // Which is exactly why the line total, not this number, is authoritative.
    expect(priced.lineTotalMinor).toBe(19n);
  });
});

describe('quotation totals', () => {
  const realistic = {
    currency: ETB,
    lines: [
      line({ quantity: 500, listUnitPriceMinor: etb(1_250), quotedUnitPriceMinor: etb(1_250) }),
      line({ quantity: 80, listUnitPriceMinor: etb(1_420), quotedUnitPriceMinor: etb(1_420), discountBp: 250 }),
      line({ quantity: 50, listUnitPriceMinor: etb(985), quotedUnitPriceMinor: etb(985) }),
    ],
    deliveryFeeMinor: etb(4_500),
    deliveryFeeTaxable: true,
    vatRateBp: 1500,
  };

  it('sums the rounded lines', () => {
    const totals = calculateTotals(realistic);
    // 625,000.00 + 113,600.00 + 49,250.00
    expect(toDecimalString({ amountMinor: totals.subtotalMinor, currency: ETB })).toBe('787850.00');
    expect(toDecimalString({ amountMinor: totals.discountTotalMinor, currency: ETB })).toBe('2840.00');
  });

  it('taxes the delivery charge when the organization says so', () => {
    const totals = calculateTotals(realistic);
    // 4,500.00 × 15% = 675.00
    expect(toDecimalString({ amountMinor: totals.deliveryTaxMinor, currency: ETB })).toBe('675.00');
  });

  it('does not tax the delivery charge when the organization says not to', () => {
    const totals = calculateTotals({ ...realistic, deliveryFeeTaxable: false });
    expect(totals.deliveryTaxMinor).toBe(0n);
    // And the grand total falls by exactly that tax.
    const taxed = calculateTotals(realistic);
    expect(taxed.grandTotalMinor - totals.grandTotalMinor).toBe(etb(675));
  });

  it('reconciles exactly', () => {
    const totals = calculateTotals(realistic);
    expect(reconciles(totals)).toBe(true);
    expect(totals.grandTotalMinor).toBe(
      totals.subtotalMinor -
        totals.discountTotalMinor +
        totals.taxTotalMinor +
        totals.deliveryFeeMinor,
    );
  });

  it('has line totals that add to the grand total, less delivery', () => {
    // The property a customer checks with a calculator.
    const totals = calculateTotals(realistic);
    const lineSum = totals.lines.reduce((acc, l) => acc + l.lineTotalMinor, 0n);
    expect(lineSum + totals.deliveryFeeMinor + totals.deliveryTaxMinor).toBe(totals.grandTotalMinor);
  });

  it('reconciles on awkward fractions', () => {
    // Prices and quantities chosen so that every rounding step lands on a half santim.
    const awkward = calculateTotals({
      currency: ETB,
      lines: [
        line({ quantity: 3, listUnitPriceMinor: 7n, quotedUnitPriceMinor: 7n, discountBp: 333, taxRateBp: 1500 }),
        line({ quantity: 7, listUnitPriceMinor: 13n, quotedUnitPriceMinor: 13n, discountBp: 777, taxRateBp: 1500 }),
        line({ quantity: 11, listUnitPriceMinor: 1n, quotedUnitPriceMinor: 1n, discountBp: 1, taxRateBp: 1500 }),
      ],
      deliveryFeeMinor: 33n,
      deliveryFeeTaxable: true,
      vatRateBp: 1500,
    });

    expect(reconciles(awkward)).toBe(true);
    const lineSum = awkward.lines.reduce((acc, l) => acc + l.lineTotalMinor, 0n);
    expect(lineSum + awkward.deliveryFeeMinor + awkward.deliveryTaxMinor).toBe(
      awkward.grandTotalMinor,
    );
  });

  it('reconciles for a hundred random-looking lines', () => {
    // Deterministic pseudo-random: a fixed sequence, so a failure is reproducible.
    const lines: PricedLineInput[] = [];
    let seed = 12345;
    for (let index = 0; index < 100; index += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      lines.push(
        line({
          quantity: (seed % 997) + 1,
          listUnitPriceMinor: BigInt((seed % 100_000) + 1),
          quotedUnitPriceMinor: BigInt((seed % 100_000) + 1),
          discountBp: seed % 1001,
          taxRateBp: seed % 2 === 0 ? 1500 : 0,
        }),
      );
    }

    const totals = calculateTotals({
      currency: ETB,
      lines,
      deliveryFeeMinor: 12_345n,
      deliveryFeeTaxable: true,
      vatRateBp: 1500,
    });

    expect(reconciles(totals)).toBe(true);
  });

  it('handles an empty quotation without inventing a total', () => {
    const totals = calculateTotals({
      currency: ETB,
      lines: [],
      deliveryFeeMinor: 0n,
      deliveryFeeTaxable: true,
      vatRateBp: 1500,
    });
    expect(totals.grandTotalMinor).toBe(0n);
    expect(reconciles(totals)).toBe(true);
  });

  it('refuses a negative delivery fee', () => {
    expect(() =>
      calculateTotals({ ...realistic, deliveryFeeMinor: -1n }),
    ).toThrow(/negative/);
  });
});

describe('discount summary', () => {
  it('reports the deepest discount, not the average', () => {
    // A quotation with one deep cut and nine full-price lines has still given away the deep cut.
    const lines = [line({ discountBp: 4000 }), ...Array.from({ length: 9 }, () => line())];
    expect(deepestDiscountBp(lines)).toBe(4000);
  });

  it('is zero for an undiscounted quotation', () => {
    expect(deepestDiscountBp([line(), line()])).toBe(0);
  });
});

describe('the price floor', () => {
  const floor = 9000; // never below 90% of list

  it('passes a line exactly at the floor', () => {
    expect(linesBelowFloor([line({ discountBp: 1000 })], floor)).toEqual([]);
  });

  it('catches a line one basis point below the floor', () => {
    expect(linesBelowFloor([line({ discountBp: 1001 })], floor)).toEqual([0]);
  });

  it('checks each line against its own list price, not a blended total', () => {
    // A deep cut on one product must not hide behind full-price volume on another.
    const lines = [line({ discountBp: 0, quantity: 1000 }), line({ discountBp: 5000 })];
    expect(linesBelowFloor(lines, floor)).toEqual([1]);
  });

  it('ignores a line with no list price to measure against', () => {
    expect(linesBelowFloor([line({ listUnitPriceMinor: 0n, discountBp: 9000 })], floor)).toEqual([]);
  });

  it('never rounds its way past the floor', () => {
    // Cross-multiplied integers: no division, so no rounding can move a breach to a pass.
    const lines = [line({ listUnitPriceMinor: 3n, quotedUnitPriceMinor: 3n, discountBp: 1001 })];
    expect(linesBelowFloor(lines, floor)).toEqual([0]);
  });
});
