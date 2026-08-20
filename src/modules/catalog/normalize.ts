/**
 * Alias normalisation.
 *
 * Customers do not write product names the way a catalogue does. "12mm", "12 mm steel",
 * "rebar 12", "12 fer" and "፲፪ ሚሜ" all mean the same bar. Normalisation is what lets a
 * deterministic matcher compare them, and keeping it in one small pure function means the
 * Phase 2 matcher can be regression-tested against a corpus of real phrasings without a
 * database or a model.
 *
 * The rules, in order:
 *
 *   1. Unicode NFC, so Amharic text that renders identically compares identically.
 *   2. Lowercase.
 *   3. Every character that is not a letter or a digit becomes a space. This deliberately
 *      discards punctuation, hyphens and slashes rather than trying to interpret them.
 *   4. A number followed by a unit is joined: "12 mm" becomes "12mm". Without this, the two
 *      commonest spellings of a rebar size normalise differently, which is precisely the case
 *      the matcher exists to handle.
 *   5. Whitespace collapses; the result is trimmed.
 *
 * What it deliberately does *not* do: stem words, translate, or reorder tokens. Similarity
 * scoring is the matcher's job in Phase 2; this function only removes noise that carries no
 * meaning.
 */

/** Units that attach to a preceding number in construction-material naming. */
const ATTACHED_UNITS = ['mm', 'cm', 'm', 'kg', 'g', 'ton', 'tonne', 'qt', 'quintal', 'l', 'ml'];

const ATTACH_PATTERN = new RegExp(`(\\d)\\s+(${ATTACHED_UNITS.join('|')})\\b`, 'g');

export function normalizeAlias(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(ATTACH_PATTERN, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a textarea of one-alias-per-line into unique, normalised, non-empty entries. */
export function parseAliasList(raw: string): { alias: string; normalizedAlias: string }[] {
  const seen = new Set<string>();
  const out: { alias: string; normalizedAlias: string }[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const alias = line.trim();
    if (!alias) continue;
    const normalizedAlias = normalizeAlias(alias);
    if (!normalizedAlias || seen.has(normalizedAlias)) continue;
    seen.add(normalizedAlias);
    out.push({ alias, normalizedAlias });
  }

  return out;
}
