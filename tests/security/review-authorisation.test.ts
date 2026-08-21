import { describe, expect, it } from 'vitest';
import { ROLES, type Role, can } from '@/platform/rbac';

/**
 * Who may reinterpret what a customer asked for.
 *
 * The server actions in `src/app/(app)/inquiries/actions.ts` each open with a
 * `requirePermission(...)` call, and the E2E suite proves the redirect actually happens for a
 * role that lacks one. This file pins the matrix those checks consult, so a later phase cannot
 * widen the grant quietly while the E2E tests keep passing for the roles they happen to cover.
 */
const INQUIRY_PERMISSIONS = [
  'read:inquiry',
  'write:inquiry',
  'parse:inquiry',
  'review:inquiry-match',
  'mark:inquiry-ready',
] as const;

const EXPECTED: Record<Role, boolean> = {
  OWNER_ADMIN: true,
  SALES_MANAGER: true,
  SALESPERSON: true,
  FINANCE: false,
  WAREHOUSE: false,
};

describe('inquiry authorisation', () => {
  for (const role of ROLES) {
    for (const permission of INQUIRY_PERMISSIONS) {
      it(`${role} ${EXPECTED[role] ? 'may' : 'may not'} ${permission}`, () => {
        expect(can(role, permission)).toBe(EXPECTED[role]);
      });
    }
  }

  it('gives finance and warehouse no route into the sales workflow', () => {
    // Not a convenience check: an inquiry review changes which product a quotation will price,
    // which is a commercial decision and not finance's or the warehouse's to make.
    for (const role of ['FINANCE', 'WAREHOUSE'] as const) {
      expect(INQUIRY_PERMISSIONS.some((permission) => can(role, permission))).toBe(false);
    }
  });

  it('does not let the ability to read products imply the ability to rematch them', () => {
    expect(can('WAREHOUSE', 'read:product')).toBe(true);
    expect(can('WAREHOUSE', 'review:inquiry-match')).toBe(false);
  });
});
