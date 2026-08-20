import { describe, expect, it } from 'vitest';
import { normalizeAlias, parseAliasList } from '@/modules/catalog/normalize';

/**
 * A corpus of the ways a customer might actually write a product name.
 *
 * This test is the reason the deterministic matcher was chosen over asking a model for a
 * product id (architecture-baseline.md 7.2): the matching rule can be pinned to real phrasings
 * and re-run on every commit, with no API key, no network and no sampling variance.
 */
describe('alias normalisation', () => {
  it('collapses the common spellings of a rebar size to one form', () => {
    const spellings = ['12mm', '12 mm', '12MM', '12-mm', '12 mm.', '  12mm  '];
    const normalised = new Set(spellings.map(normalizeAlias));
    expect([...normalised]).toEqual(['12mm']);
  });

  it('keeps the descriptive words that distinguish products', () => {
    expect(normalizeAlias('12 mm steel')).toBe('12mm steel');
    expect(normalizeAlias('12mm rebar')).toBe('12mm rebar');
    // Different products must not normalise together.
    expect(normalizeAlias('Rebar 12mm')).not.toBe(normalizeAlias('Rebar 16mm'));
  });

  it('strips punctuation without gluing words together', () => {
    expect(normalizeAlias('OPC-Cement, 50kg')).toBe('opc cement 50kg');
    expect(normalizeAlias('3/4" gravel')).toBe('3 4 gravel');
  });

  it('attaches a unit only to a preceding number', () => {
    expect(normalizeAlias('50 kg cement')).toBe('50kg cement');
    // "m" as a standalone word is not a unit suffix here, because no number precedes it.
    expect(normalizeAlias('cement m')).toBe('cement m');
  });

  it('preserves Amharic text', () => {
    expect(normalizeAlias('ስሚንቶ')).toBe('ስሚንቶ');
    expect(normalizeAlias('  ብረት 12  ')).toBe('ብረት 12');
  });

  it('treats composed and decomposed Unicode as the same text', () => {
    const composed = 'café';
    const decomposed = 'café';
    expect(normalizeAlias(composed)).toBe(normalizeAlias(decomposed));
  });

  it('returns an empty string for input carrying no signal', () => {
    expect(normalizeAlias('!!!')).toBe('');
    expect(normalizeAlias('   ')).toBe('');
  });
});

describe('parseAliasList', () => {
  it('drops blanks and duplicates that normalise alike', () => {
    const parsed = parseAliasList('12mm\n\n12 mm\n  \n12MM\n12mm rebar');
    expect(parsed.map((entry) => entry.normalizedAlias)).toEqual(['12mm', '12mm rebar']);
  });

  it('keeps the original spelling alongside the normalised form', () => {
    const [first] = parseAliasList('  12 mm steel  ');
    expect(first).toEqual({ alias: '12 mm steel', normalizedAlias: '12mm steel' });
  });

  it('handles CRLF line endings', () => {
    expect(parseAliasList('12mm\r\n16mm')).toHaveLength(2);
  });
});
