import {
  type Money,
  add,
  money,
  multiplyByBasisPoints,
  multiplyByQuantity,
  subtract,
  sum,
  zero,
} from '@/platform/money';

/**
 * Quotation arithmetic.
 *
 * A pure function over snapshotted numbers. No database, no clock, no configuration lookup and
 * emphatically no language model — a quotation total is the figure a distributor will check by
 * hand against a calculator, and if it does not agree, nothing else this product says will be
 * believed.
 *
 * ## The calculation order, exactly
 *
 * Per line, in this sequence:
 *
 *   gross     = quantity × quotedUnitPrice                    (exact; no rounding)
 *   discount  = half-up(gross × discountBp / 10 000)
 *   taxable   = gross − discount
 *   tax       = half-up(taxable × taxRateBp / 10 000)
 *   lineTotal = taxable + tax
 *
 * Then across lines:
 *
 *   subtotal      = Σ gross
 *   discountTotal = Σ discount
 *   deliveryTax   = half-up(deliveryFee × vatRateBp / 10 000)  when delivery is taxable, else 0
 *   taxTotal      = Σ tax + deliveryTax
 *   grandTotal    = Σ lineTotal + deliveryFee + deliveryTax
 *
 * ## Why round per line and then sum
 *
 * The alternative — sum exact values and round once at the end — produces a total that is
 * arguably more accurate and definitely less defensible: the printed line totals would not add
 * up to the printed grand total, and the first customer to check would be right to query it.
 * Rounding at the line makes every displayed figure a real number that reconciles. The identity
 *
 *     grandTotal = subtotal − discountTotal + taxTotal + deliveryFee
 *
 * holds exactly, and `reconcile()` below asserts it.
 *
 * ## Why the discount applies to the line, not the unit price
 *
 * Discounting the unit price first and multiplying second loses up to half a santim per unit,
 * which on 15 000 blocks is real money and, worse, produces a per-unit price that does not
 * divide the line total. Applying it to the gross keeps the line internally consistent.
 */

/** 100% in basis points. */
export const BASIS_POINTS = 10_000;

export interface PricedLineInput {
  /** Whole units. Fractional quantities are refused upstream — see the module docs. */
  readonly quantity: number;
  readonly listUnitPriceMinor: bigint;
  /** The price the line is built from. Equals the list price unless overridden. */
  readonly quotedUnitPriceMinor: bigint;
  readonly discountBp: number;
  readonly taxRateBp: number;
}

export interface PricedLine extends PricedLineInput {
  readonly lineSubtotalMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly taxableAmountMinor: bigint;
  readonly taxMinor: bigint;
  readonly lineTotalMinor: bigint;
  /**
   * The per-unit price after discount, for display only.
   *
   * Deliberately not stored and never used in arithmetic: it is a rounded quotient, and
   * multiplying it back by the quantity will not always give the line total. The line total is
   * authoritative; this exists so a salesperson can see what the discount did to the unit price.
   */
  readonly effectiveUnitPriceMinor: bigint;
}

export interface QuotationTotalsInput {
  readonly currency: string;
  readonly lines: readonly PricedLineInput[];
  readonly deliveryFeeMinor: bigint;
  /** Whether the delivery charge attracts VAT. An organization setting, never assumed. */
  readonly deliveryFeeTaxable: boolean;
  /** The organization's VAT rate, applied to the delivery charge when it is taxable. */
  readonly vatRateBp: number;
}

export interface QuotationTotals {
  readonly lines: readonly PricedLine[];
  readonly subtotalMinor: bigint;
  readonly discountTotalMinor: bigint;
  readonly deliveryFeeMinor: bigint;
  readonly deliveryTaxMinor: bigint;
  readonly taxTotalMinor: bigint;
  readonly grandTotalMinor: bigint;
}

function assertWholeQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(
      `quotation quantity must be a whole number greater than zero, received ${quantity}`,
    );
  }
}

function assertBasisPoints(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > BASIS_POINTS) {
    throw new Error(`${label} must be an integer between 0 and ${BASIS_POINTS}, received ${value}`);
  }
}

/**
 * The per-unit price after discount.
 *
 * **Display only.** Multiplying it back by the quantity will not always give the line total,
 * because the discount is applied to the line rather than to the unit. Defined once, here, so
 * the review screen and the pricing engine cannot end up showing different numbers for it.
 */
export function effectiveUnitPrice(
  quotedUnitPriceMinor: bigint,
  discountBp: number,
  currency: string,
): bigint {
  return multiplyByBasisPoints(
    money(quotedUnitPriceMinor, currency),
    BASIS_POINTS - discountBp,
    'half-up',
  ).amountMinor;
}

/** Prices one line. Every intermediate value is an integer count of minor units. */
export function priceLine(input: PricedLineInput, currency: string): PricedLine {
  assertWholeQuantity(input.quantity);
  assertBasisPoints(input.discountBp, 'discountBp');
  if (!Number.isInteger(input.taxRateBp) || input.taxRateBp < 0) {
    throw new Error(`taxRateBp must be a non-negative integer, received ${input.taxRateBp}`);
  }
  if (input.quotedUnitPriceMinor < 0n || input.listUnitPriceMinor < 0n) {
    throw new Error('a unit price cannot be negative');
  }

  const unit: Money = money(input.quotedUnitPriceMinor, currency);

  const gross = multiplyByQuantity(unit, input.quantity);
  const discount = multiplyByBasisPoints(gross, input.discountBp, 'half-up');
  const taxable = subtract(gross, discount);
  const tax = multiplyByBasisPoints(taxable, input.taxRateBp, 'half-up');
  const lineTotal = add(taxable, tax);

  const effectiveUnitPriceMinor = effectiveUnitPrice(
    input.quotedUnitPriceMinor,
    input.discountBp,
    currency,
  );

  return {
    ...input,
    lineSubtotalMinor: gross.amountMinor,
    lineDiscountMinor: discount.amountMinor,
    taxableAmountMinor: taxable.amountMinor,
    taxMinor: tax.amountMinor,
    lineTotalMinor: lineTotal.amountMinor,
    effectiveUnitPriceMinor,
  };
}

export function calculateTotals(input: QuotationTotalsInput): QuotationTotals {
  const { currency } = input;
  if (input.deliveryFeeMinor < 0n) throw new Error('a delivery fee cannot be negative');

  const lines = input.lines.map((line) => priceLine(line, currency));

  const subtotal = sum(
    lines.map((line) => money(line.lineSubtotalMinor, currency)),
    currency,
  );
  const discountTotal = sum(
    lines.map((line) => money(line.lineDiscountMinor, currency)),
    currency,
  );
  const lineTax = sum(
    lines.map((line) => money(line.taxMinor, currency)),
    currency,
  );
  const lineTotals = sum(
    lines.map((line) => money(line.lineTotalMinor, currency)),
    currency,
  );

  const deliveryFee = money(input.deliveryFeeMinor, currency);
  const deliveryTax = input.deliveryFeeTaxable
    ? multiplyByBasisPoints(deliveryFee, input.vatRateBp, 'half-up')
    : zero(currency);

  const taxTotal = add(lineTax, deliveryTax);
  const grandTotal = add(add(lineTotals, deliveryFee), deliveryTax);

  return {
    lines,
    subtotalMinor: subtotal.amountMinor,
    discountTotalMinor: discountTotal.amountMinor,
    deliveryFeeMinor: deliveryFee.amountMinor,
    deliveryTaxMinor: deliveryTax.amountMinor,
    taxTotalMinor: taxTotal.amountMinor,
    grandTotalMinor: grandTotal.amountMinor,
  };
}

/**
 * The identity every quotation must satisfy:
 *
 *     grandTotal = subtotal − discountTotal + taxTotal + deliveryFee
 *
 * Asserted in tests and cheap enough to assert again at write time. A quotation whose parts do
 * not add up to its whole is not a rounding preference, it is a bug, and it should stop rather
 * than reach a customer.
 */
export function reconciles(totals: QuotationTotals): boolean {
  const expected =
    totals.subtotalMinor -
    totals.discountTotalMinor +
    totals.taxTotalMinor +
    totals.deliveryFeeMinor;
  return expected === totals.grandTotalMinor;
}

/**
 * The deepest discount on any line, in basis points.
 *
 * The approval ladder is driven by the worst line rather than by an average: a quotation with
 * one line at 40% and nine at zero has given away 40% on something, and averaging would hide it.
 */
export function deepestDiscountBp(lines: readonly PricedLineInput[]): number {
  return lines.reduce((worst, line) => Math.max(worst, line.discountBp), 0);
}

/**
 * Lines priced below the configured floor, expressed as a fraction of their own list price.
 *
 * `minimumPriceFloorBp` is a floor on the quoted price relative to list — 9000 means "never
 * below 90% of list". Computed per line against that line's own list price, because a floor
 * measured against a blended total would let a deep cut on one product hide behind full-price
 * volume on another.
 */
export function linesBelowFloor(
  lines: readonly PricedLineInput[],
  minimumPriceFloorBp: number,
): number[] {
  const breaches: number[] = [];

  lines.forEach((line, index) => {
    if (line.listUnitPriceMinor === 0n) return;

    // effective = quoted × (10000 − discount) / 10000, compared against list × floor / 10000.
    // Cross-multiplied to stay in integers: no division, no rounding, no float.
    const effectiveScaled =
      line.quotedUnitPriceMinor * BigInt(BASIS_POINTS - line.discountBp) * BigInt(BASIS_POINTS);
    const floorScaled =
      line.listUnitPriceMinor * BigInt(minimumPriceFloorBp) * BigInt(BASIS_POINTS);

    if (effectiveScaled < floorScaled) breaches.push(index);
  });

  return breaches;
}
