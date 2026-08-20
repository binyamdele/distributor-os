import { normalizeAlias } from './normalize';

/**
 * Deterministic product matching.
 *
 * This is the half of inquiry parsing that decides *which product a customer meant*, and it is
 * deliberately not the language model's job. The reasons are recorded in
 * `docs/architecture-baseline.md` 7.2, and they come down to two properties this module has and
 * a model does not: the score is **reproducible** — the same words always produce the same
 * number — and it is **explainable**, so the salesperson reading "matched the approved alias
 * 12mm" can tell whether to trust it.
 *
 * The whole thing is a pure function over a corpus. The corpus is loaded tenant-scoped by the
 * caller, so another organization's products are not filtered out of the results — they are
 * never in the scoring set at all.
 */

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * At or above this, the match is a strong suggestion: the reviewer is expected to glance and
 * confirm. **Only an exact canonical or exact alias hit can reach it** — see FUZZY_MAX_CONFIDENCE.
 */
export const STRONG_THRESHOLD = 0.9;

/** Below this, no product is named at all. Expressed structurally: see FUZZY_SCORE_FLOOR. */
export const REVIEW_THRESHOLD = 0.7;

/**
 * The structural cap that makes the bands mean something.
 *
 * A fuzzy match can never be a strong suggestion, however good the string similarity looks.
 * String resemblance is evidence about spelling, not about intent: "Rebar 12mm" and
 * "Rebar 16mm" differ by one character and are different products, one of which costs 77% more.
 * Capping fuzzy at 0.89 means the >= 0.90 band is earned by an exact match against something a
 * human put in the catalogue, and never by a coincidence of letters.
 *
 * This is why the thresholds are not tuned to the test corpus: they are not fitted to data at
 * all. They partition *kinds of evidence*.
 */
export const FUZZY_MAX_CONFIDENCE = 0.89;

/**
 * The weakest string similarity admitted as evidence, on the raw Dice scale.
 *
 * This value *defines* the 0.70 confidence point: raw scores from FUZZY_SCORE_FLOOR to 1.0 are
 * mapped linearly onto 0.70 to 0.89. So "confidence below 0.70" is not a band a candidate can
 * land in — it is the absence of a candidate. Chosen at 0.45 because below roughly half the
 * trigrams in common, the surviving matches in the demo corpus are coincidences of shared
 * words like "cement" rather than references to the same product.
 */
export const FUZZY_SCORE_FLOOR = 0.45;

/**
 * Two candidates closer together than this cannot be separated by the evidence.
 *
 * When that happens the top score is reduced and the item is flagged ambiguous, because the
 * failure here is not "picked the lower-scoring product" — it is "picked one at all".
 */
export const AMBIGUITY_MARGIN = 0.05;

/** How much confidence an ambiguous top candidate loses. */
export const AMBIGUITY_PENALTY = 0.1;

/**
 * Multiplier applied when the request names a size the product does not have.
 *
 * The decisive fact in a construction-material catalogue is usually a number: 8, 10, 12, 16.
 * Pure string similarity barely separates "Rebar 12mm" from "Rebar 16mm", so without this rule
 * a request for 12mm would produce four near-identical candidates. With it, a size that
 * disagrees is pushed below the floor and drops out.
 */
export const SPEC_MISMATCH_PENALTY = 0.35;

/** Bonus multiplier when the request names a size the product does have. */
export const SPEC_MATCH_BONUS = 1.2;

/** How many candidates the review screen is offered. */
export const MAX_CANDIDATES = 4;

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/** Character trigrams of an already-normalised string. */
export function trigrams(value: string): Set<string> {
  const out = new Set<string>();
  if (value.length < 3) {
    if (value.length > 0) out.add(value);
    return out;
  }
  for (let index = 0; index <= value.length - 3; index += 1) {
    out.add(value.slice(index, index + 3));
  }
  return out;
}

/**
 * Dice coefficient over character trigrams: 2|A ∩ B| / (|A| + |B|).
 *
 * Chosen over Levenshtein because it is insensitive to word order — "rebar 12mm" and
 * "12mm rebar" are the same request, and an edit-distance metric would call them far apart.
 */
export function trigramDice(a: string, b: string): number {
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * Numbers that look like a product specification.
 *
 * "12mm", "12 mm" (already joined by normalizeAlias), "50kg", or a bare "12" in "rebar 12".
 * A quantity like "500" in "500 bags cement" is a different thing, but quantities are extracted
 * by the parser into their own field and are not part of the name being matched here.
 */
export function specNumbers(normalized: string): Set<number> {
  const out = new Set<number>();
  for (const token of normalized.matchAll(/\d+/g)) {
    const value = Number(token[0]);
    if (Number.isFinite(value)) out.add(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corpus and results
// ---------------------------------------------------------------------------

export interface MatchableProduct {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly unit: string;
  /** Approved alternative spellings, already normalised. */
  readonly aliases: readonly string[];
}

export type DeterministicMatchMethod = 'CANONICAL' | 'ALIAS' | 'FUZZY' | 'UNRESOLVED';

export interface MatchCandidate {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly unit: string;
  readonly confidence: number;
  readonly method: Exclude<DeterministicMatchMethod, 'UNRESOLVED'>;
  /** Shown verbatim in the review UI. */
  readonly reason: string;
  /** The raw similarity before mapping, for debugging and metrics. 1 for exact matches. */
  readonly rawScore: number;
  /** The catalogue string the request was matched against. */
  readonly matchedOn: string;
}

export interface MatchOutcome {
  readonly method: DeterministicMatchMethod;
  readonly best: MatchCandidate | null;
  readonly candidates: readonly MatchCandidate[];
  readonly ambiguous: boolean;
  readonly confidence: number;
  readonly reason: string;
  /** The normalised form the matcher actually compared. Useful when a match looks wrong. */
  readonly normalizedQuery: string;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Maps a raw Dice score onto the fuzzy confidence band [REVIEW_THRESHOLD, FUZZY_MAX_CONFIDENCE]. */
export function mapFuzzyConfidence(rawScore: number): number {
  const span = 1 - FUZZY_SCORE_FLOOR;
  const position = Math.min(1, Math.max(0, (rawScore - FUZZY_SCORE_FLOOR) / span));
  return round(REVIEW_THRESHOLD + position * (FUZZY_MAX_CONFIDENCE - REVIEW_THRESHOLD));
}

interface Evidence {
  score: number;
  matchedOn: string;
  method: 'CANONICAL' | 'ALIAS' | 'FUZZY';
  specNote: string;
}

function bestEvidence(query: string, product: MatchableProduct): Evidence | null {
  const canonical = normalizeAlias(product.name);
  if (query === canonical) {
    return { score: 1, matchedOn: product.name, method: 'CANONICAL', specNote: '' };
  }
  for (const alias of product.aliases) {
    if (query === alias) {
      return { score: 1, matchedOn: alias, method: 'ALIAS', specNote: '' };
    }
  }

  // Fuzzy: the product's best-resembling string, whether that is its name or an alias.
  const targets = [canonical, ...product.aliases];
  let bestScore = 0;
  let bestTarget = canonical;
  for (const target of targets) {
    const score = trigramDice(query, target);
    if (score > bestScore) {
      bestScore = score;
      bestTarget = target;
    }
  }

  const querySpecs = specNumbers(query);
  const productSpecs = specNumbers([canonical, ...product.aliases].join(' '));
  let specNote = '';

  if (querySpecs.size > 0 && productSpecs.size > 0) {
    const shared = [...querySpecs].some((value) => productSpecs.has(value));
    if (shared) {
      bestScore = Math.min(1, bestScore * SPEC_MATCH_BONUS);
      specNote = ' The size in the request matches this product.';
    } else {
      bestScore *= SPEC_MISMATCH_PENALTY;
      specNote = ' The size in the request does not match this product.';
    }
  }

  if (bestScore < FUZZY_SCORE_FLOOR) return null;
  return { score: bestScore, matchedOn: bestTarget, method: 'FUZZY', specNote };
}

/**
 * Matches one requested name against a catalogue.
 *
 * `corpus` must already be scoped to the acting organization. This function has no access to a
 * database and therefore cannot leak across tenants — but it also cannot protect against being
 * handed the wrong corpus, which is why `findProductCandidates` below is the only intended
 * caller in application code.
 */
export function matchProduct(
  rawName: string,
  corpus: readonly MatchableProduct[],
): MatchOutcome {
  const query = normalizeAlias(rawName);

  if (!query) {
    return {
      method: 'UNRESOLVED',
      best: null,
      candidates: [],
      ambiguous: false,
      confidence: 0,
      reason: 'The requested name contained no letters or digits to match on.',
      normalizedQuery: query,
    };
  }

  const scored: MatchCandidate[] = [];
  for (const product of corpus) {
    const evidence = bestEvidence(query, product);
    if (!evidence) continue;

    const confidence =
      evidence.method === 'CANONICAL' ? 1 : evidence.method === 'ALIAS' ? 0.98 : mapFuzzyConfidence(evidence.score);

    const reason =
      evidence.method === 'CANONICAL'
        ? `Exact match on the catalogue name "${product.name}".`
        : evidence.method === 'ALIAS'
          ? `Exact match on the approved alias "${evidence.matchedOn}".`
          : `Resembles "${evidence.matchedOn}" (similarity ${round(evidence.score).toFixed(2)}).${evidence.specNote}`;

    scored.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      confidence,
      method: evidence.method,
      reason,
      rawScore: round(evidence.score),
      matchedOn: evidence.matchedOn,
    });
  }

  if (scored.length === 0) {
    return {
      method: 'UNRESOLVED',
      best: null,
      candidates: [],
      ambiguous: false,
      confidence: 0,
      reason: `Nothing in the catalogue resembles "${rawName}" closely enough to name a product.`,
      normalizedQuery: query,
    };
  }

  // Ties broken by SKU so the ordering is stable across runs and machines.
  scored.sort((a, b) =>
    b.confidence === a.confidence ? a.sku.localeCompare(b.sku) : b.confidence - a.confidence,
  );

  const top = scored[0]!;
  const runnerUp = scored[1];
  const ambiguous = runnerUp !== undefined && top.confidence - runnerUp.confidence < AMBIGUITY_MARGIN;

  const confidence = ambiguous
    ? round(Math.max(REVIEW_THRESHOLD, top.confidence - AMBIGUITY_PENALTY))
    : top.confidence;

  const best: MatchCandidate = { ...top, confidence };

  const reason = ambiguous
    ? `${top.reason} A second product scores almost the same (${runnerUp!.name}), so this needs a person to choose.`
    : top.reason;

  return {
    method: top.method,
    best,
    /*
     * The candidate list keeps its *unpenalised* scores, while `confidence` above carries the
     * ambiguity penalty. Applying the penalty inside the list made the proposed product display
     * a lower number than the alternatives it was being preferred over, which reads as a bug to
     * anyone looking at the screen. The item is less certain because the alternatives are close;
     * the alternatives themselves have not become better or worse.
     */
    candidates: scored.slice(0, MAX_CANDIDATES),
    ambiguous,
    confidence,
    reason,
    normalizedQuery: query,
  };
}

/** Which band a confidence falls into. Drives presentation, not authority. */
export type ConfidenceBand = 'strong' | 'review' | 'unresolved';

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= STRONG_THRESHOLD) return 'strong';
  if (confidence >= REVIEW_THRESHOLD) return 'review';
  return 'unresolved';
}
