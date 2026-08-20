import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  formatMoney,
  money,
  multiplyByBasisPoints,
  multiplyByQuantity,
  parseDecimal,
  roundDivision,
  subtract,
  sum,
  toDecimalString,
} from '@/platform/money';

/**
 * Money is the part of this system a distributor will check by hand. If a quotation's lines do
 * not add up to its total, nothing else the product says will be believed.
 */
describe('money', () => {
  describe('refuses floating point at the boundary', () => {
    it('rejects a non-integer number of minor units', () => {
      expect(() => money(12.5, 'ETB')).toThrow(/non-integer/);
    });

    it('rejects a non-integer quantity', () => {
      expect(() => multiplyByQuantity(money(100_00, 'ETB'), 2.5)).toThrow(/whole number/);
    });

    it('survives amounts beyond Number.MAX_SAFE_INTEGER', () => {
      // ETB 10 trillion in santim exceeds a float64's exact integer range. A Number-based
      // implementation loses santim here; bigint does not.
      const huge = money(10_000_000_000_000_00n, 'ETB');
      const total = add(huge, money(1n, 'ETB'));
      expect(total.amountMinor).toBe(10_000_000_000_000_01n);
      expect(toDecimalString(total)).toBe('10000000000000.01');
    });

    it('does not reproduce the 0.1 + 0.2 problem', () => {
      const total = add(money(10, 'ETB'), money(20, 'ETB'));
      expect(total.amountMinor).toBe(30n);
      expect(toDecimalString(total)).toBe('0.30');
    });
  });

  describe('rounding', () => {
    it('rounds half away from zero for half-up', () => {
      expect(roundDivision(5n, 2n, 'half-up')).toBe(3n);
      expect(roundDivision(-5n, 2n, 'half-up')).toBe(-3n);
    });

    it('rounds half to even for half-even', () => {
      expect(roundDivision(5n, 2n, 'half-even')).toBe(2n);
      expect(roundDivision(7n, 2n, 'half-even')).toBe(4n);
    });

    it('floors and ceils across the sign boundary', () => {
      expect(roundDivision(-5n, 2n, 'floor')).toBe(-3n);
      expect(roundDivision(-5n, 2n, 'ceil')).toBe(-2n);
      expect(roundDivision(-5n, 2n, 'trunc')).toBe(-2n);
    });

    it('refuses division by zero rather than returning a number', () => {
      expect(() => roundDivision(1n, 0n, 'half-up')).toThrow(/division by zero/);
    });
  });

  describe('VAT at 15%', () => {
    it('computes tax on a line exactly', () => {
      // 500 bags of cement at ETB 1,250.00
      const line = multiplyByQuantity(money(1_250_00n, 'ETB'), 500);
      expect(toDecimalString(line)).toBe('625000.00');

      const vat = multiplyByBasisPoints(line, 1500);
      expect(toDecimalString(vat)).toBe('93750.00');
      expect(toDecimalString(add(line, vat))).toBe('718750.00');
    });

    it('rounds a fractional santim half-up', () => {
      // ETB 0.07 at 15% is 0.0105 -> 1.05 santim -> 1 santim.
      expect(multiplyByBasisPoints(money(7n, 'ETB'), 1500).amountMinor).toBe(1n);
      // ETB 0.10 at 15% is 1.5 santim -> 2 santim under half-up.
      expect(multiplyByBasisPoints(money(10n, 'ETB'), 1500).amountMinor).toBe(2n);
    });
  });

  describe('line totals sum to the grand total', () => {
    it('holds for a realistic mixed quotation', () => {
      const lines = [
        multiplyByQuantity(money(1_250_00n, 'ETB'), 500),
        multiplyByQuantity(money(1_420_00n, 'ETB'), 80),
        multiplyByQuantity(money(985_00n, 'ETB'), 50),
      ];
      const taxes = lines.map((line) => multiplyByBasisPoints(line, 1500));

      const subtotal = sum(lines, 'ETB');
      const taxTotal = sum(taxes, 'ETB');
      const grand = add(subtotal, taxTotal);

      // 500 x 1,250.00 = 625,000.00
      //  80 x 1,420.00 = 113,600.00
      //  50 x   985.00 =  49,250.00
      // The displayed figures must reconcile exactly — this is the property a customer checks.
      expect(toDecimalString(subtotal)).toBe('787850.00');
      // Tax is computed per line and summed: 93,750.00 + 17,040.00 + 7,387.50
      expect(toDecimalString(taxTotal)).toBe('118177.50');
      expect(toDecimalString(grand)).toBe('906027.50');
      expect(sum([...lines, ...taxes], 'ETB').amountMinor).toBe(grand.amountMinor);
    });
  });

  describe('currency safety', () => {
    it('refuses to add two currencies', () => {
      expect(() => add(money(1n, 'ETB'), money(1n, 'USD'))).toThrow(/refusing to combine/);
    });

    it('refuses to subtract two currencies', () => {
      expect(() => subtract(money(1n, 'ETB'), money(1n, 'USD'))).toThrow(/refusing to combine/);
    });

    it('rejects a malformed currency code', () => {
      expect(() => money(1n, 'etb')).toThrow(/invalid currency/);
    });
  });

  describe('allocate', () => {
    it('never loses or invents a santim', () => {
      const shares = allocate(money(100_00n, 'ETB'), [1n, 1n, 1n]);
      expect(sum(shares, 'ETB').amountMinor).toBe(100_00n);
      expect(shares.map((s) => s.amountMinor)).toEqual([3334n, 3333n, 3333n]);
    });

    it('is deterministic for equal weights', () => {
      const first = allocate(money(10n, 'ETB'), [1n, 1n, 1n]);
      const second = allocate(money(10n, 'ETB'), [1n, 1n, 1n]);
      expect(first.map((s) => s.amountMinor)).toEqual(second.map((s) => s.amountMinor));
    });

    it('handles a negative amount without losing a unit', () => {
      const shares = allocate(money(-100_00n, 'ETB'), [1n, 1n, 1n]);
      expect(sum(shares, 'ETB').amountMinor).toBe(-100_00n);
    });
  });

  describe('parseDecimal', () => {
    it('accepts what a salesperson would type', () => {
      const parsed = parseDecimal('1,420.50', 'ETB');
      expect(parsed.ok && parsed.value.amountMinor).toBe(142_050n);
    });

    it('refuses more precision than the currency has', () => {
      const parsed = parseDecimal('12.345', 'ETB');
      expect(parsed.ok).toBe(false);
    });

    it('refuses text that is not a number', () => {
      expect(parseDecimal('abc', 'ETB').ok).toBe(false);
      expect(parseDecimal('', 'ETB').ok).toBe(false);
    });

    it('round-trips through the decimal string form', () => {
      const parsed = parseDecimal('787100.00', 'ETB');
      expect(parsed.ok && toDecimalString(parsed.value)).toBe('787100.00');
    });
  });

  it('formats ETB for display', () => {
    expect(formatMoney(money(1_250_00n, 'ETB'))).toContain('1,250.00');
  });
});
