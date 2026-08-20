/**
 * Unit vocabulary.
 *
 * Customers write "bags", "bag", "pcs", "pieces" and "no." for the same thing. The catalogue
 * stores one canonical token per product. This module maps the former onto the latter, and —
 * more importantly — refuses to map across physical kinds.
 *
 * There is deliberately **no conversion** here. A product sold by the bag does not accept a
 * quantity in kilograms, even though a bag has a mass, because the conversion factor is a
 * property of the product that nobody has entered yet. Guessing it would turn "500 kg cement"
 * into a confident, wrong line on a quotation. Phase 2 flags the mismatch and asks a human.
 */

/** Canonical unit tokens. These are the values a Product may carry. */
export const CANONICAL_UNITS = [
  'bag',
  'piece',
  'm3',
  'm2',
  'm',
  'kg',
  'quintal',
  'ton',
  'roll',
  'sheet',
  'litre',
] as const;

export type CanonicalUnit = (typeof CANONICAL_UNITS)[number];

/**
 * Spellings seen in real inquiries, mapped to a canonical token.
 *
 * Amharic entries are included because customers do write them: ከረጢት (bag), ቁራጭ (piece),
 * ኪሎ (kilo), ኩንታል (quintal).
 */
const UNIT_ALIASES: Readonly<Record<string, CanonicalUnit>> = {
  bag: 'bag',
  bags: 'bag',
  sack: 'bag',
  sacks: 'bag',
  ከረጢት: 'bag',

  pc: 'piece',
  pcs: 'piece',
  piece: 'piece',
  pieces: 'piece',
  pce: 'piece',
  no: 'piece',
  nos: 'piece',
  unit: 'piece',
  units: 'piece',
  ቁራጭ: 'piece',

  m3: 'm3',
  cbm: 'm3',
  cubic: 'm3',
  'cubic metre': 'm3',
  'cubic meter': 'm3',

  m2: 'm2',
  sqm: 'm2',
  'square metre': 'm2',
  'square meter': 'm2',

  m: 'm',
  metre: 'm',
  meter: 'm',
  metres: 'm',
  meters: 'm',

  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  ኪሎ: 'kg',

  qt: 'quintal',
  quintal: 'quintal',
  quintals: 'quintal',
  ኩንታል: 'quintal',

  ton: 'ton',
  tons: 'ton',
  tonne: 'ton',
  tonnes: 'ton',
  t: 'ton',

  roll: 'roll',
  rolls: 'roll',

  sheet: 'sheet',
  sheets: 'sheet',

  l: 'litre',
  ltr: 'litre',
  litre: 'litre',
  litres: 'litre',
  liter: 'litre',
  liters: 'litre',
};

/**
 * Maps a written unit onto a canonical token, or null when it is not recognised.
 *
 * Null is a real answer, not a failure: an unrecognised unit is shown to the salesperson
 * rather than guessed at.
 */
export function normalizeUnit(raw: string | null | undefined): CanonicalUnit | null {
  if (!raw) return null;
  const key = raw.normalize('NFC').toLowerCase().replace(/[.\s]+/g, ' ').trim();
  if (!key) return null;
  return UNIT_ALIASES[key] ?? UNIT_ALIASES[key.replace(/\s+/g, '')] ?? null;
}

export type UnitCompatibility =
  /** The customer's unit resolves to the product's unit. */
  | 'match'
  /** The customer gave no unit; the product's own unit is adopted, and the UI says so. */
  | 'assumed'
  /** The customer gave a unit that means something else. A human decides. */
  | 'mismatch'
  /** The customer gave a unit nobody recognises. A human decides. */
  | 'unknown';

export interface UnitCheck {
  readonly compatibility: UnitCompatibility;
  /** The unit that would be used. Null only when the requested unit is unrecognised. */
  readonly resolvedUnit: string | null;
  readonly reason: string;
}

/**
 * Decides whether a requested unit can stand for a product's unit.
 *
 * `assumed` is permitted through the readiness gate; `mismatch` and `unknown` are not. That
 * asymmetry is deliberate: saying nothing about units is normal in a short message ("80 12mm
 * rebar"), whereas naming a different unit is a claim that disagrees with the catalogue.
 */
export function checkUnit(requestedUnit: string | null, productUnit: string): UnitCheck {
  if (!requestedUnit) {
    return {
      compatibility: 'assumed',
      resolvedUnit: productUnit,
      reason: `No unit given; assuming ${productUnit}, the unit this product is sold in.`,
    };
  }

  const normalized = normalizeUnit(requestedUnit);
  if (!normalized) {
    return {
      compatibility: 'unknown',
      resolvedUnit: null,
      reason: `"${requestedUnit}" is not a unit this system recognises.`,
    };
  }

  if (normalized === normalizeUnit(productUnit)) {
    return {
      compatibility: 'match',
      resolvedUnit: productUnit,
      reason: `Requested in ${normalized}, which is how this product is sold.`,
    };
  }

  return {
    compatibility: 'mismatch',
    resolvedUnit: null,
    reason:
      `Requested in ${normalized}, but this product is sold by the ${productUnit}. ` +
      'No conversion is defined, so a person must decide.',
  };
}

/** Quantity bounds. Above this, a parse is far likelier to be an error than an order. */
export const MAX_REQUESTED_QUANTITY = 1_000_000;

export type QuantityProblem = 'not-a-number' | 'not-an-integer' | 'not-positive' | 'too-large';

export function validateQuantity(value: unknown): QuantityProblem | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'not-a-number';
  if (!Number.isInteger(value)) return 'not-an-integer';
  if (value <= 0) return 'not-positive';
  if (value > MAX_REQUESTED_QUANTITY) return 'too-large';
  return null;
}
