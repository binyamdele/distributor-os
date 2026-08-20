import { type Result, fail, ok } from '@/platform/result';

/**
 * Money.
 *
 * An integer count of minor units (santim for ETB) plus an ISO-4217 currency. There is no
 * floating point in this module and none is permitted anywhere in the money path:
 * `0.1 + 0.2 !== 0.3` is not an acceptable property for a system that tells a distributor
 * what a customer owes.
 *
 * Rates — VAT, discounts, price floors — enter as integer basis points or explicit
 * numerator/denominator pairs. A JS number is never multiplied against an amount.
 *
 * Ported from CommerceOS `packages/domain/src/money.ts`, trimmed of the currency-conversion
 * and attribution machinery this product does not need yet.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

/** ISO-4217 minor-unit exponents that differ from the 2-decimal default. ETB uses 2. */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  DJF: 0,
  GNF: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  XAF: 0,
  XOF: 0,
};

export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENTS[currency.toUpperCase()] ?? 2;
}

export type RoundingMode = 'half-up' | 'half-even' | 'floor' | 'ceil' | 'trunc';

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`refusing to combine ${a} with ${b}: currencies must be converted explicitly`);
    this.name = 'CurrencyMismatchError';
  }
}

function assertValidCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`invalid currency code "${currency}"`);
  }
}

export function money(amountMinor: bigint | number | string, currency: string): Money {
  assertValidCurrency(currency);
  if (typeof amountMinor === 'number') {
    if (!Number.isInteger(amountMinor)) {
      throw new Error(
        `money() received the non-integer ${amountMinor}. Amounts are minor units; a ` +
          'fractional value means a float leaked into the money path.',
      );
    }
    return { amountMinor: BigInt(amountMinor), currency };
  }
  if (typeof amountMinor === 'string') {
    if (!/^-?\d+$/.test(amountMinor)) {
      throw new Error(`money() received "${amountMinor}", which is not an integer string`);
    }
    return { amountMinor: BigInt(amountMinor), currency };
  }
  return { amountMinor, currency };
}

export function zero(currency: string): Money {
  return money(0n, currency);
}

export function isZero(value: Money): boolean {
  return value.amountMinor === 0n;
}

export function isNegative(value: Money): boolean {
  return value.amountMinor < 0n;
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function negate(value: Money): Money {
  return { amountMinor: -value.amountMinor, currency: value.currency };
}

export function abs(value: Money): Money {
  return {
    amountMinor: value.amountMinor < 0n ? -value.amountMinor : value.amountMinor,
    currency: value.currency,
  };
}

/** Sums a list. An empty list needs an explicit currency — there is no currency-less zero. */
export function sum(values: readonly Money[], currency: string): Money {
  let total = 0n;
  for (const value of values) {
    if (value.currency !== currency) throw new CurrencyMismatchError(currency, value.currency);
    total += value.amountMinor;
  }
  return { amountMinor: total, currency };
}

/** Multiplies by a whole number of units — a line quantity. Exact, no rounding. */
export function multiplyByQuantity(value: Money, quantity: bigint | number): Money {
  if (typeof quantity === 'number' && !Number.isInteger(quantity)) {
    throw new Error('quantity must be a whole number');
  }
  const q = typeof quantity === 'number' ? BigInt(quantity) : quantity;
  return { amountMinor: value.amountMinor * q, currency: value.currency };
}

export function roundDivision(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new Error('division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let rounded: bigint;
  switch (mode) {
    case 'trunc':
      rounded = quotient;
      break;
    case 'floor':
      rounded = negative ? quotient + 1n : quotient;
      break;
    case 'ceil':
      rounded = negative ? quotient : quotient + 1n;
      break;
    case 'half-up':
      rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
      break;
    case 'half-even': {
      const doubled = remainder * 2n;
      if (doubled > absDenominator) rounded = quotient + 1n;
      else if (doubled < absDenominator) rounded = quotient;
      else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
  }
  return negative ? -rounded : rounded;
}

/**
 * Applies a rate in basis points (1 bp = 0.01%). VAT, discounts and price floors all arrive
 * this way, so the rate itself is exact and only the product needs rounding.
 *
 * Half-up is the default because it is what an Ethiopian invoice reader expects, and because
 * banker's rounding on a per-line VAT would produce totals a customer would query.
 */
export function multiplyByBasisPoints(
  value: Money,
  basisPoints: bigint | number,
  mode: RoundingMode = 'half-up',
): Money {
  if (typeof basisPoints === 'number' && !Number.isInteger(basisPoints)) {
    throw new Error('basis points must be a whole number');
  }
  const bp = typeof basisPoints === 'number' ? BigInt(basisPoints) : basisPoints;
  return {
    amountMinor: roundDivision(value.amountMinor * bp, 10_000n, mode),
    currency: value.currency,
  };
}

/** Applies an exact ratio. */
export function multiplyByRatio(
  value: Money,
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): Money {
  return {
    amountMinor: roundDivision(value.amountMinor * numerator, denominator, mode),
    currency: value.currency,
  };
}

/**
 * Splits an amount across weights without losing or inventing a single santim. Largest
 * remainder: floor every share, then hand the leftover units to the shares with the biggest
 * discarded remainder. `sum(allocate(x, w)) === x` always.
 */
export function allocate(value: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new Error('allocate() requires at least one weight');
  if (weights.some((w) => w < 0n)) throw new Error('allocate() weights must not be negative');

  const totalWeight = weights.reduce((acc, w) => acc + w, 0n);
  if (totalWeight === 0n) throw new Error('allocate() weights must not sum to zero');

  const negative = value.amountMinor < 0n;
  const total = negative ? -value.amountMinor : value.amountMinor;

  const shares = weights.map((weight) => (total * weight) / totalWeight);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (total * weight) % totalWeight,
  }));

  const flooredTotal = shares.reduce((acc, share) => acc + share, 0n);
  let leftover = total - flooredTotal;

  // Ties broken by original index, so allocation is deterministic and reproducible.
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );

  let cursor = 0;
  while (leftover > 0n) {
    const target = remainders[cursor % remainders.length];
    if (target) {
      shares[target.index] = (shares[target.index] ?? 0n) + 1n;
      leftover -= 1n;
    }
    cursor += 1;
  }

  return shares.map((share) => ({
    amountMinor: negative ? -share : share,
    currency: value.currency,
  }));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function greaterThan(a: Money, b: Money): boolean {
  return compare(a, b) === 1;
}

export function lessThan(a: Money, b: Money): boolean {
  return compare(a, b) === -1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/** Parses a human-entered decimal string ("12.34") into Money. Rejects excess precision. */
export function parseDecimal(input: string, currency: string): Result<Money> {
  const trimmed = input.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return fail('VALIDATION_FAILED', `"${input}" is not a valid amount`);
  }
  const exponent = minorUnitExponent(currency);
  const [wholeRaw = '0', fractionRaw = ''] = trimmed.replace('-', '').split('.');
  if (fractionRaw.length > exponent) {
    return fail(
      'VALIDATION_FAILED',
      `${currency} has ${exponent} minor digits; "${input}" carries more precision than the currency supports`,
    );
  }
  const padded = fractionRaw.padEnd(exponent, '0');
  const magnitude = BigInt(`${wholeRaw}${padded}` || '0');
  return ok({ amountMinor: trimmed.startsWith('-') ? -magnitude : magnitude, currency });
}

/** Decimal string form: 123456n ETB -> "1234.56". String arithmetic only. */
export function toDecimalString(value: Money): string {
  const exponent = minorUnitExponent(value.currency);
  const negative = value.amountMinor < 0n;
  const digits = (negative ? -value.amountMinor : value.amountMinor).toString();
  if (exponent === 0) return `${negative ? '-' : ''}${digits}`;

  const padded = digits.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Display only. The Number() cast here is the single place a money value touches a float, and
 * its result is never stored, compared or arithmetically combined — it exists solely to hand a
 * value to Intl for locale formatting.
 */
export function formatMoney(value: Money, locale = 'en-ET'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: minorUnitExponent(value.currency),
  }).format(Number(toDecimalString(value)));
}

/** Compact form for dense tables: "ETB 3.42M". Display only, never a stored figure. */
export function formatMoneyCompact(value: Money, locale = 'en-ET'): string {
  const magnitude = Number(toDecimalString(value));
  return `${value.currency} ${new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(magnitude)}`;
}

/** Wire form. The amount is a string so a large aggregate never loses precision in JSON. */
export interface MoneyDto {
  readonly amountMinor: string;
  readonly currency: string;
}

export function toDto(value: Money): MoneyDto {
  return { amountMinor: value.amountMinor.toString(), currency: value.currency };
}

export function fromDto(dto: MoneyDto): Money {
  return money(dto.amountMinor, dto.currency);
}
