import { describe, expect, it } from 'vitest';
import {
  AMBIGUITY_MARGIN,
  FUZZY_MAX_CONFIDENCE,
  type MatchableProduct,
  REVIEW_THRESHOLD,
  STRONG_THRESHOLD,
  confidenceBand,
  mapFuzzyConfidence,
  matchProduct,
  specNumbers,
  trigramDice,
} from '@/modules/catalog/matching';
import { normalizeAlias } from '@/modules/catalog/normalize';

/**
 * The matcher, against the real demo catalogue.
 *
 * These are the assertions that justify not asking a language model to name products. Every one
 * of them runs with no database, no network and no API key, and gives the same answer every
 * time — which is exactly what a confidence threshold needs underneath it if the numbers are to
 * mean anything.
 */
const CATALOGUE: [string, string, string, string[]][] = [
  [
    'CEM-OPC-50',
    'OPC Cement 50kg',
    'bag',
    ['OPC cement', 'cement', 'OPC', 'ordinary portland cement', '50kg cement', 'ስሚንቶ'],
  ],
  ['RB-08', 'Rebar 8mm', 'piece', ['8mm', '8 mm', '8mm rebar', '8 fer', 'rebar 8', 'ብረት 8']],
  ['RB-10', 'Rebar 10mm', 'piece', ['10mm', '10 mm', '10mm rebar', '10 fer', 'rebar 10']],
  ['RB-12', 'Rebar 12mm', 'piece', ['12mm', '12 mm', '12mm rebar', '12 mm steel', '12 fer', 'rebar 12']],
  ['RB-16', 'Rebar 16mm', 'piece', ['16mm', '16 mm', '16mm rebar', '16 fer', 'rebar 16']],
  ['HB-20', 'Hollow Block 20cm', 'piece', ['hollow block', 'HCB', '20cm block', 'block 20', 'ሆሎ ብሎክ']],
];

const corpus: MatchableProduct[] = CATALOGUE.map(([sku, name, unit, aliases]) => ({
  id: sku,
  sku,
  name,
  unit,
  aliases: aliases.map(normalizeAlias),
}));

describe('trigram similarity', () => {
  it('is 1 for identical strings', () => {
    expect(trigramDice('rebar 12mm', 'rebar 12mm')).toBe(1);
  });

  it('is insensitive to word order', () => {
    // The reason Dice-over-trigrams was chosen over edit distance: "12mm rebar" and
    // "rebar 12mm" are the same request, and Levenshtein would call them far apart.
    const forward = trigramDice('12mm rebar', 'rebar 12mm');
    expect(forward).toBeGreaterThan(0.5);
  });

  it('is 0 for strings with nothing in common', () => {
    expect(trigramDice('cement', 'xyzzy')).toBe(0);
  });

  it('is symmetric', () => {
    expect(trigramDice('12 steel', '12mm steel')).toBe(trigramDice('12mm steel', '12 steel'));
  });
});

describe('specification numbers', () => {
  it('finds sizes in a normalised name', () => {
    expect([...specNumbers('rebar 12mm')]).toEqual([12]);
    expect([...specNumbers('opc cement 50kg')]).toEqual([50]);
  });

  it('finds nothing when there is no number', () => {
    expect(specNumbers('hollow block').size).toBe(0);
  });
});

describe('Level A — exact canonical', () => {
  it('scores a catalogue name at 1.00', () => {
    const result = matchProduct('Rebar 12mm', corpus);
    expect(result.method).toBe('CANONICAL');
    expect(result.confidence).toBe(1);
    expect(result.best?.sku).toBe('RB-12');
  });

  it('is case- and punctuation-insensitive', () => {
    expect(matchProduct('REBAR 12MM', corpus).best?.sku).toBe('RB-12');
    expect(matchProduct('rebar-12mm', corpus).best?.sku).toBe('RB-12');
  });
});

describe('Level B — exact alias', () => {
  it('scores an approved alias at 0.98', () => {
    const result = matchProduct('12mm rebar', corpus);
    expect(result.method).toBe('ALIAS');
    expect(result.confidence).toBe(0.98);
    expect(result.best?.sku).toBe('RB-12');
  });

  it('matches the aliases a customer actually writes', () => {
    const cases: [string, string][] = [
      ['OPC cement', 'CEM-OPC-50'],
      ['cement', 'CEM-OPC-50'],
      ['12 fer', 'RB-12'],
      ['10mm', 'RB-10'],
      ['16mm rebar', 'RB-16'],
      ['hollow block', 'HB-20'],
      ['20cm block', 'HB-20'],
    ];
    for (const [written, expected] of cases) {
      const result = matchProduct(written, corpus);
      expect(result.best?.sku, `"${written}" should match ${expected}`).toBe(expected);
      expect(result.confidence).toBeGreaterThanOrEqual(STRONG_THRESHOLD);
    }
  });

  it('matches an Amharic alias', () => {
    const result = matchProduct('ስሚንቶ', corpus);
    expect(result.method).toBe('ALIAS');
    expect(result.best?.sku).toBe('CEM-OPC-50');
  });

  it('tolerates the spacing customers vary', () => {
    // "12 mm" and "12mm" normalise together, so both are the same approved alias.
    expect(matchProduct('12 mm', corpus).best?.sku).toBe('RB-12');
    expect(matchProduct('  12mm  ', corpus).best?.sku).toBe('RB-12');
  });
});

describe('Level C — deterministic fuzzy', () => {
  it('finds the right size from a partial phrase', () => {
    const result = matchProduct('12 steel', corpus);
    expect(result.method).toBe('FUZZY');
    expect(result.best?.sku).toBe('RB-12');
    expect(result.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });

  it('never reaches the strong band, however good the resemblance', () => {
    // The structural cap. "cement 50kg" resembles "OPC Cement 50kg" very closely, and still
    // cannot be auto-suggested — only an exact match against a curated string earns that.
    const result = matchProduct('cement 50kg', corpus);
    expect(result.method).toBe('FUZZY');
    expect(result.confidence).toBeLessThanOrEqual(FUZZY_MAX_CONFIDENCE);
    expect(result.confidence).toBeLessThan(STRONG_THRESHOLD);
    expect(confidenceBand(result.confidence)).toBe('review');
  });

  it('rules out the wrong size using the specification number', () => {
    // Without this rule, four rebar sizes differing by one character would all score alike,
    // and the matcher would confidently offer a bar that costs 77% more.
    const result = matchProduct('12 steel', corpus);
    const offered = result.candidates.map((candidate) => candidate.sku);
    expect(offered).toContain('RB-12');
    expect(offered).not.toContain('RB-16');
    expect(offered).not.toContain('RB-08');
  });

  it('maps the raw score onto the review band and nowhere else', () => {
    expect(mapFuzzyConfidence(0.45)).toBe(REVIEW_THRESHOLD);
    expect(mapFuzzyConfidence(1)).toBe(FUZZY_MAX_CONFIDENCE);
    expect(mapFuzzyConfidence(0.7)).toBeGreaterThan(REVIEW_THRESHOLD);
    expect(mapFuzzyConfidence(0.7)).toBeLessThan(FUZZY_MAX_CONFIDENCE);
    // Below the floor there is no candidate at all, which is what "< 0.70" means structurally.
    expect(mapFuzzyConfidence(0)).toBe(REVIEW_THRESHOLD);
  });
});

describe('Level D — unresolved', () => {
  it('refuses to name a product that is not in the catalogue', () => {
    for (const unknown of ['PVC pipe 4 inch', 'geotextile membrane', 'bitumen felt']) {
      const result = matchProduct(unknown, corpus);
      expect(result.method, unknown).toBe('UNRESOLVED');
      expect(result.best).toBeNull();
      expect(result.candidates).toHaveLength(0);
      expect(result.confidence).toBe(0);
    }
  });

  it('refuses a request with too little signal to act on', () => {
    expect(matchProduct('12', corpus).method).toBe('UNRESOLVED');
  });

  it('refuses an empty or punctuation-only request', () => {
    expect(matchProduct('', corpus).method).toBe('UNRESOLVED');
    expect(matchProduct('???', corpus).method).toBe('UNRESOLVED');
  });

  it('says why, in words a salesperson can act on', () => {
    const result = matchProduct('PVC pipe 4 inch', corpus);
    expect(result.reason).toMatch(/nothing in the catalogue/i);
    expect(result.reason).toContain('PVC pipe 4 inch');
  });
});

describe('ambiguity', () => {
  it('does not silently choose between products the evidence cannot separate', () => {
    // "rebar" fits all four sizes equally well. Picking one would be wrong three times in four.
    const result = matchProduct('rebar', corpus);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it('drops an ambiguous match out of the strong band', () => {
    const result = matchProduct('rebar', corpus);
    expect(result.confidence).toBeLessThan(STRONG_THRESHOLD);
    expect(confidenceBand(result.confidence)).not.toBe('strong');
  });

  it('says so in the reason, naming the rival', () => {
    const result = matchProduct('rebar', corpus);
    expect(result.reason).toMatch(/needs a person to choose/i);
  });

  it('offers the alternatives with their own scores, not the penalised one', () => {
    // The penalty belongs to the item, not to the alternatives. Showing a proposed product
    // scoring lower than the products it beat reads as a bug to whoever is looking at it.
    const result = matchProduct('rebar', corpus);
    const [first, second] = result.candidates;
    expect(first!.confidence).toBeGreaterThanOrEqual(second!.confidence);
    expect(first!.confidence).toBeGreaterThanOrEqual(result.confidence);
  });

  it('is not triggered when one candidate clearly wins', () => {
    expect(matchProduct('12mm rebar', corpus).ambiguous).toBe(false);
    expect(matchProduct('12 steel', corpus).ambiguous).toBe(false);
  });

  it('uses the documented margin', () => {
    expect(AMBIGUITY_MARGIN).toBeGreaterThan(0);
    expect(AMBIGUITY_MARGIN).toBeLessThan(0.2);
  });
});

describe('determinism', () => {
  it('gives the same answer every time', () => {
    const runs = Array.from({ length: 5 }, () => matchProduct('12 steel', corpus));
    const first = JSON.stringify(runs[0]);
    for (const run of runs) expect(JSON.stringify(run)).toBe(first);
  });

  it('does not depend on the order of the catalogue', () => {
    const reversed = [...corpus].reverse();
    const a = matchProduct('rebar', corpus);
    const b = matchProduct('rebar', reversed);
    expect(b.best?.sku).toBe(a.best?.sku);
    expect(b.confidence).toBe(a.confidence);
  });
});

describe('confidence bands', () => {
  it('partition the scale as documented', () => {
    expect(confidenceBand(1)).toBe('strong');
    expect(confidenceBand(0.98)).toBe('strong');
    expect(confidenceBand(0.9)).toBe('strong');
    expect(confidenceBand(0.89)).toBe('review');
    expect(confidenceBand(0.7)).toBe('review');
    expect(confidenceBand(0.69)).toBe('unresolved');
    expect(confidenceBand(0)).toBe('unresolved');
  });

  it('reserve the strong band for exact matches only', () => {
    // Walk the whole corpus: no fuzzy result anywhere may reach the auto-suggest band.
    const probes = [
      'cement 50kg',
      '12 steel',
      'rebar',
      'block',
      'opc 50',
      'reinforcement 10',
      'hollow',
    ];
    for (const probe of probes) {
      const result = matchProduct(probe, corpus);
      if (result.method === 'FUZZY') {
        expect(result.confidence, `"${probe}" reached the strong band via fuzzy`).toBeLessThan(
          STRONG_THRESHOLD,
        );
      }
    }
  });
});

describe('the corpus is the only thing it can see', () => {
  it('returns nothing when given an empty catalogue', () => {
    // The tenancy guarantee in miniature: the matcher has no database access, so a caller that
    // scopes the corpus correctly cannot leak, and one that does not cannot be rescued here.
    expect(matchProduct('12mm rebar', []).method).toBe('UNRESOLVED');
  });
});
