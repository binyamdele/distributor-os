import { describe, expect, it } from 'vitest';
import {
  MAX_REQUESTED_QUANTITY,
  checkUnit,
  normalizeUnit,
  validateQuantity,
} from '@/modules/catalog/units';

describe('unit normalisation', () => {
  it('collapses the spellings of a piece', () => {
    for (const written of ['pcs', 'pc', 'piece', 'pieces', 'PCS', 'nos', 'no.']) {
      expect(normalizeUnit(written), written).toBe('piece');
    }
  });

  it('collapses the spellings of a bag', () => {
    for (const written of ['bag', 'bags', 'sack', 'sacks', 'BAGS']) {
      expect(normalizeUnit(written), written).toBe('bag');
    }
  });

  it('understands Amharic unit words', () => {
    expect(normalizeUnit('ከረጢት')).toBe('bag');
    expect(normalizeUnit('ኩንታል')).toBe('quintal');
    expect(normalizeUnit('ኪሎ')).toBe('kg');
  });

  it('handles multi-word units', () => {
    expect(normalizeUnit('cubic metre')).toBe('m3');
    expect(normalizeUnit('square meter')).toBe('m2');
  });

  it('returns null rather than guessing', () => {
    // Null is a real answer here: an unrecognised unit reaches a person instead of a default.
    expect(normalizeUnit('lorries')).toBeNull();
    expect(normalizeUnit('')).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
    expect(normalizeUnit(undefined)).toBeNull();
  });
});

describe('unit compatibility', () => {
  it('accepts a unit that means the product’s own unit', () => {
    const check = checkUnit('bags', 'bag');
    expect(check.compatibility).toBe('match');
    expect(check.resolvedUnit).toBe('bag');
  });

  it('adopts the product’s unit when the customer gave none', () => {
    // "80 12mm rebar" is normal phrasing, not an error.
    const check = checkUnit(null, 'piece');
    expect(check.compatibility).toBe('assumed');
    expect(check.resolvedUnit).toBe('piece');
    expect(check.reason).toMatch(/assuming piece/i);
  });

  it('refuses to convert between physical kinds', () => {
    // A bag of cement has a mass, but nobody has entered the factor, and inventing one would
    // put a confident wrong number on a quotation.
    const check = checkUnit('kg', 'bag');
    expect(check.compatibility).toBe('mismatch');
    expect(check.resolvedUnit).toBeNull();
    expect(check.reason).toMatch(/no conversion is defined/i);
  });

  it('flags a unit it does not recognise', () => {
    const check = checkUnit('truckloads', 'bag');
    expect(check.compatibility).toBe('unknown');
    expect(check.resolvedUnit).toBeNull();
  });

  it('does not treat quintal and ton as interchangeable', () => {
    expect(checkUnit('quintal', 'ton').compatibility).toBe('mismatch');
  });
});

describe('quantity validation', () => {
  it('accepts a whole positive number', () => {
    expect(validateQuantity(1)).toBeNull();
    expect(validateQuantity(500)).toBeNull();
    expect(validateQuantity(MAX_REQUESTED_QUANTITY)).toBeNull();
  });

  it('rejects zero and negatives', () => {
    expect(validateQuantity(0)).toBe('not-positive');
    expect(validateQuantity(-5)).toBe('not-positive');
  });

  it('rejects fractions', () => {
    expect(validateQuantity(2.5)).toBe('not-an-integer');
  });

  it('rejects non-finite values', () => {
    expect(validateQuantity(Number.NaN)).toBe('not-a-number');
    expect(validateQuantity(Number.POSITIVE_INFINITY)).toBe('not-a-number');
    expect(validateQuantity('500')).toBe('not-a-number');
    expect(validateQuantity(null)).toBe('not-a-number');
    expect(validateQuantity(undefined)).toBe('not-a-number');
  });

  it('rejects an absurd quantity', () => {
    expect(validateQuantity(MAX_REQUESTED_QUANTITY + 1)).toBe('too-large');
  });
});
