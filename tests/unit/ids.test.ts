import { describe, expect, it } from 'vitest';
import { isUuid } from '@/platform/ids';

/**
 * The shape check that keeps a hand-typed URL from becoming a 500.
 *
 * Phase 5 found this the hard way: `getPayment('not-a-uuid')` reached Prisma and raised
 * `Inconsistent column data: Error creating UUID`. The same hole existed on every Phase 3 and
 * Phase 4 lookup. A malformed id, another tenant's id and an id that was never issued must all
 * come back as the same "not found" — anything else is a signal to whoever is probing.
 */
describe('isUuid', () => {
  it('accepts a real uuid in either case', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('rejects the things that actually arrive in a URL', () => {
    for (const value of [
      'not-a-uuid',
      '',
      '   ',
      '00000000-0000-0000-0000-00000000000', // one short
      '00000000-0000-0000-0000-0000000000000', // one long
      '3f2504e0-4f89-41d3-9a0c-0305e82c330g', // not hex
      '3f2504e04f8941d39a0c0305e82c3301', // unhyphenated
      'urn:uuid:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301' OR '1'='1",
      '../../etc/passwd',
    ]) {
      expect(isUuid(value), `${JSON.stringify(value)} should be rejected`).toBe(false);
    }
  });

  it('rejects anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(isUuid(value)).toBe(false);
    }
  });

  it('does not accept a trailing newline', () => {
    // `$` alone would match before a trailing newline, which is how a check like this quietly
    // stops being a check.
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301\n')).toBe(false);
  });
});
