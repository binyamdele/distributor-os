import { createHash } from 'node:crypto';

/**
 * Canonical serialisation for hashing.
 *
 * This underpins approval binding (architecture-baseline.md 7.4): an approval is bound to the
 * hash of the exact figures approved, so any change to those figures invalidates it. That
 * gives this function two obligations, and both are load-bearing:
 *
 *   1. **Structurally identical payloads must hash the same.** Otherwise a harmless
 *      re-serialisation revokes a valid approval, and managers learn to re-approve reflexively
 *      — which defeats the point of asking them.
 *   2. **Different payloads must hash differently.** Otherwise an edited quotation reuses an
 *      old approval, which is exactly the failure this mechanism exists to prevent.
 *
 * Obligation 2 is why every value is type-tagged rather than coerced into whatever
 * `JSON.stringify` happens to produce. Plain stringify collides in ways that matter here —
 * notably `5n` and `"5n"` both becoming `"5n"`. Money is bigint minor units, so that collision
 * sits directly on the approval path: an amount and a string spelling of it would hash alike.
 *
 * Ported from CommerceOS `packages/security/src/hashing.ts`.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(tag(value));
}

/**
 * Encodes a value together with its type, so no two values of different types can produce the
 * same canonical form. The prefixes are arbitrary but must never change: changing one changes
 * every stored hash, invalidating every historical approval binding at once.
 */
function tag(value: unknown): unknown {
  if (value === null) return { $: 'null' };
  if (value === undefined) return { $: 'undefined' };

  switch (typeof value) {
    case 'string':
      // NFC, so that visually identical text is the same text. Matters for Amharic input.
      return { $: 's', v: value.normalize('NFC') };
    case 'boolean':
      return { $: 'b', v: value };
    case 'bigint':
      return { $: 'i', v: value.toString() };
    case 'number':
      if (Number.isNaN(value)) return { $: 'n', v: 'NaN' };
      if (value === Infinity) return { $: 'n', v: 'Infinity' };
      if (value === -Infinity) return { $: 'n', v: '-Infinity' };
      if (Object.is(value, -0)) return { $: 'n', v: '-0' };
      return { $: 'n', v: value };
    case 'symbol':
    case 'function':
      // Neither can be part of a meaningful payload. Refusing beats hashing them as null and
      // letting two different payloads agree.
      throw new TypeError(`a ${typeof value} cannot appear in a hashed payload`);
  }

  if (Array.isArray(value)) return { $: 'a', v: value.map(tag) };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('an invalid Date cannot be hashed');
    // Always UTC, so the hash cannot depend on the machine's timezone.
    return { $: 'd', v: value.toISOString() };
  }
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([k, v]) => [canonicalize(k), tag(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return { $: 'm', v: entries };
  }
  if (value instanceof Set) {
    return { $: 'set', v: [...value].map(canonicalize).sort() };
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // An absent key and a key set to undefined mean the same thing to a reviewer reading the
    // payload, so they must hash the same.
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k.normalize('NFC'), tag(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  /*
   * Two distinct source keys can normalise to the same NFC form. `Object.fromEntries` would
   * silently keep the last, so a two-key payload would hash identically to a one-key payload
   * and a manager would approve a display that does not match what was hashed. The ambiguity
   * is refused rather than resolved, because any resolution rule is one the reviewer cannot see.
   */
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]![0] === entries[index - 1]![0]) {
      throw new TypeError(
        `payload contains two keys that normalise to "${entries[index]![0]}"; the intended ` +
          'value would be ambiguous and cannot be hashed',
      );
    }
  }

  return { $: 'o', v: Object.fromEntries(entries) };
}

/** SHA-256 of the canonical form, hex encoded. */
export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** SHA-256 of a raw string. Used for session tokens and AI input fingerprints. */
export function hashString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Short, non-reversible fingerprint suitable for display in the UI. */
export function shortHash(value: unknown): string {
  return hashPayload(value).slice(0, 12);
}
