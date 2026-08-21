import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  type Permission,
  ROLES,
  ROLE_LABEL_KEYS,
  ROLE_PERMISSIONS,
  type Role,
  can,
} from '@/platform/rbac';
import { PRISMA_ROLES } from '../support/prisma-meta';

/**
 * The permission matrix, asserted in both directions.
 *
 * A test that only checks the grants would pass a matrix that granted everything to everyone.
 * Every (role, permission) pair is therefore checked against an explicit expectation, and the
 * denials are the half that matters.
 */
describe('roles', () => {
  it('match the Role enum in the database schema', () => {
    // Drift here would let a role exist in one place and not the other, which surfaces as a
    // login that succeeds and then authorises nothing.
    expect([...ROLES].sort()).toEqual([...PRISMA_ROLES].sort());
  });

  it('each have a label key for the UI', () => {
    for (const role of ROLES) expect(ROLE_LABEL_KEYS[role]).toBeTruthy();
  });

  it('grant no permission that is not in the master list', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(known.has(permission), `${role} has unknown permission ${permission}`).toBe(true);
      }
    }
  });
});

describe('the matrix', () => {
  /** Expected grants, written out rather than derived, so the test can disagree with the code. */
  const EXPECTED: Record<Role, readonly Permission[]> = {
    OWNER_ADMIN: PERMISSIONS,
    SALES_MANAGER: [
      'read:dashboard',
      'read:customer',
      'read:product',
      'read:inquiry',
      'read:quotation',
      'read:order',
      'read:receivables',
      'read:audit',
      'read:settings',
      'write:customer',
      'write:inquiry',
      'parse:inquiry',
      'review:inquiry-match',
      'mark:inquiry-ready',
      'create:quotation',
      'edit:quotation',
      'submit:quotation',
      'approve:quotation:self_limit',
      'approve:quotation:manager_limit',
      'mark:quotation-sent',
      'read:follow-up',
      'complete:follow-up',
      'record:quotation-acceptance',
      'record:quotation-rejection',
      'create:sales-order',
      'submit:payment-evidence',
      'approve:customer-message',
      'set:customer-credit',
      'cancel:order',
      'read:warehouse-task',
      'read:delivery',
      'assign:delivery',
      'dispatch:delivery',
      'complete:delivery',
      'fail:delivery',
    ],
    SALESPERSON: [
      'read:dashboard',
      'read:customer',
      'read:product',
      'read:inquiry',
      'read:quotation',
      'read:order',
      'write:customer',
      'write:inquiry',
      'parse:inquiry',
      'review:inquiry-match',
      'mark:inquiry-ready',
      'create:quotation',
      'edit:quotation',
      'submit:quotation',
      'approve:quotation:self_limit',
      'mark:quotation-sent',
      'read:follow-up',
      'complete:follow-up',
      'record:quotation-acceptance',
      'record:quotation-rejection',
      'create:sales-order',
      'submit:payment-evidence',
      'approve:customer-message',
      'read:warehouse-task',
      'read:delivery',
    ],
    FINANCE: [
      'read:dashboard',
      'read:customer',
      'read:quotation',
      'read:order',
      'read:payment',
      'review:payment',
      'read:receivables',
      'read:audit',
      'confirm:payment',
      'reject:payment',
      'set:customer-credit',
      'approve:customer-message',
      'read:warehouse-task',
      'read:delivery',
    ],
    WAREHOUSE: [
      'read:dashboard',
      'read:order',
      'read:product',
      'read:warehouse',
      'read:delivery',
      'adjust:stock',
      'read:warehouse-task',
      'create:warehouse-task',
      'start:warehouse-task',
      'prepare:warehouse-task',
      'complete:warehouse-task',
      'record:pickup',
    ],
  };

  for (const role of ROLES) {
    describe(role, () => {
      const granted = new Set<Permission>(EXPECTED[role]);

      for (const permission of PERMISSIONS) {
        const shouldHave = granted.has(permission);
        it(`${shouldHave ? 'can' : 'cannot'} ${permission}`, () => {
          expect(can(role, permission)).toBe(shouldHave);
        });
      }
    });
  }
});

describe('separation of duties', () => {
  it('keeps payment confirmation away from sales', () => {
    // The whole payment-review design rests on this: nobody who can create the order can also
    // declare that the money for it arrived.
    expect(can('SALESPERSON', 'confirm:payment')).toBe(false);
    expect(can('SALES_MANAGER', 'confirm:payment')).toBe(false);
    expect(can('WAREHOUSE', 'confirm:payment')).toBe(false);
    expect(can('FINANCE', 'confirm:payment')).toBe(true);
  });

  it('does not let a salesperson approve beyond their own limit', () => {
    expect(can('SALESPERSON', 'approve:quotation:self_limit')).toBe(true);
    expect(can('SALESPERSON', 'approve:quotation:manager_limit')).toBe(false);
    expect(can('SALES_MANAGER', 'approve:quotation:manager_limit')).toBe(true);
  });

  it('lets finance read quotations without touching a price', () => {
    expect(can('FINANCE', 'read:quotation')).toBe(true);
    expect(can('FINANCE', 'create:quotation')).toBe(false);
    expect(can('FINANCE', 'edit:quotation')).toBe(false);
    expect(can('FINANCE', 'approve:quotation:self_limit')).toBe(false);
    expect(can('FINANCE', 'mark:quotation-sent')).toBe(false);
  });

  it('keeps warehouse out of quotations entirely', () => {
    for (const permission of [
      'read:quotation',
      'create:quotation',
      'edit:quotation',
      'approve:quotation:self_limit',
    ] as const) {
      expect(can('WAREHOUSE', permission)).toBe(false);
    }
  });

  it('separates drafting a quotation from approving and from sending it', () => {
    // Three distinct acts. A role can hold any one without the others, which is what makes the
    // approval gate a gate rather than a formality.
    expect(PERMISSIONS).toContain('create:quotation');
    expect(PERMISSIONS).toContain('approve:quotation:self_limit');
    expect(PERMISSIONS).toContain('mark:quotation-sent');
  });

  it('keeps submitting a payment claim separate from confirming one', () => {
    // The two halves of the review gate. Sales submits because sales is who the customer sends
    // the screenshot to; Finance confirms. Finance deliberately holds neither the submit
    // permission nor sales' order permissions, so every confirmed payment has been through two
    // pairs of hands — which is the entire value of the gate.
    expect(can('SALESPERSON', 'submit:payment-evidence')).toBe(true);
    expect(can('SALES_MANAGER', 'submit:payment-evidence')).toBe(true);
    expect(can('FINANCE', 'submit:payment-evidence')).toBe(false);

    expect(can('SALESPERSON', 'confirm:payment')).toBe(false);
    expect(can('FINANCE', 'confirm:payment')).toBe(true);
  });

  it('does not let sales see the payment queue or receivables', () => {
    expect(can('SALESPERSON', 'read:payment')).toBe(false);
    expect(can('SALESPERSON', 'review:payment')).toBe(false);
    expect(can('SALESPERSON', 'read:receivables')).toBe(false);
    // A sales manager tracks what is owed, but still cannot open the evidence.
    expect(can('SALES_MANAGER', 'read:receivables')).toBe(true);
    expect(can('SALES_MANAGER', 'review:payment')).toBe(false);
  });

  it('keeps warehouse away from payment evidence entirely', () => {
    // The warehouse needs to know an order is ready. It does not need a customer's bank slip.
    for (const permission of [
      'read:payment',
      'review:payment',
      'confirm:payment',
      'submit:payment-evidence',
      'read:receivables',
    ] as const) {
      expect(can('WAREHOUSE', permission)).toBe(false);
    }
    expect(can('WAREHOUSE', 'read:order')).toBe(true);
  });

  it('does not let warehouse staff touch prices or customers', () => {
    expect(can('WAREHOUSE', 'write:product')).toBe(false);
    expect(can('WAREHOUSE', 'write:customer')).toBe(false);
    expect(can('WAREHOUSE', 'read:customer')).toBe(false);
  });

  it('does not let finance write quotations', () => {
    expect(can('FINANCE', 'edit:quotation')).toBe(false);
    expect(can('FINANCE', 'approve:quotation:self_limit')).toBe(false);
  });

  it('keeps inquiry interpretation inside sales', () => {
    // Finance and warehouse have no business reinterpreting what a customer asked for, and
    // granting them the ability "so the demo flows" is how a permission model starts rotting.
    for (const permission of ['parse:inquiry', 'review:inquiry-match', 'mark:inquiry-ready'] as const) {
      expect(can('FINANCE', permission)).toBe(false);
      expect(can('WAREHOUSE', permission)).toBe(false);
      expect(can('SALESPERSON', permission)).toBe(true);
      expect(can('SALES_MANAGER', permission)).toBe(true);
      expect(can('OWNER_ADMIN', permission)).toBe(true);
    }
  });

  it('separates reviewing a match from typing an inquiry in', () => {
    // Distinct permissions, so a future data-entry role can hold one without the other. The
    // matrix happens to grant both to sales today; the separation is what makes that a choice.
    expect(PERMISSIONS).toContain('write:inquiry');
    expect(PERMISSIONS).toContain('review:inquiry-match');
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('separates recording what a customer said from committing stock to it', () => {
    // Two different acts. Recording an acceptance reports a conversation; creating the order
    // takes goods out of everyone else's reach. A future clerk role could hold the first alone.
    expect(PERMISSIONS).toContain('record:quotation-acceptance');
    expect(PERMISSIONS).toContain('create:sales-order');
  });

  it('lets a salesperson raise an order but not cancel one', () => {
    // Cancelling releases reserved stock and unwinds a commitment, which is a manager's call.
    expect(can('SALESPERSON', 'create:sales-order')).toBe(true);
    expect(can('SALESPERSON', 'cancel:order')).toBe(false);
    expect(can('SALES_MANAGER', 'cancel:order')).toBe(true);
  });

  it('keeps follow-ups and order creation inside sales', () => {
    for (const permission of [
      'read:follow-up',
      'complete:follow-up',
      'record:quotation-acceptance',
      'record:quotation-rejection',
      'create:sales-order',
    ] as const) {
      expect(can('FINANCE', permission)).toBe(false);
      expect(can('WAREHOUSE', permission)).toBe(false);
      expect(can('SALESPERSON', permission)).toBe(true);
      expect(can('SALES_MANAGER', permission)).toBe(true);
    }
  });

  it('lets finance and warehouse read orders without reserving anything', () => {
    expect(can('FINANCE', 'read:order')).toBe(true);
    expect(can('WAREHOUSE', 'read:order')).toBe(true);
    expect(can('FINANCE', 'create:sales-order')).toBe(false);
    expect(can('WAREHOUSE', 'create:sales-order')).toBe(false);
    expect(can('WAREHOUSE', 'cancel:order')).toBe(false);
  });

  it('separates handing goods out from picking them', () => {
    // Completing a task consumes stock: quantity leaves the yard and a reservation becomes
    // history. Picking is reversible; that is not. Distinct permissions so a future picker role
    // can hold one without the other, even though a small yard grants both today.
    expect(PERMISSIONS).toContain('start:warehouse-task');
    expect(PERMISSIONS).toContain('prepare:warehouse-task');
    expect(PERMISSIONS).toContain('complete:warehouse-task');
    expect(can('WAREHOUSE', 'complete:warehouse-task')).toBe(true);
  });

  it('does not let the warehouse close an order end to end on its own', () => {
    // The warehouse hands goods out. Declaring them delivered is somebody else's signature —
    // otherwise one role could ship and sign for the same goods with nobody else involved.
    expect(can('WAREHOUSE', 'complete:warehouse-task')).toBe(true);
    expect(can('WAREHOUSE', 'dispatch:delivery')).toBe(false);
    expect(can('WAREHOUSE', 'complete:delivery')).toBe(false);
    expect(can('WAREHOUSE', 'fail:delivery')).toBe(false);
    expect(can('WAREHOUSE', 'assign:delivery')).toBe(false);
    // It can still see where its own work went.
    expect(can('WAREHOUSE', 'read:delivery')).toBe(true);
  });

  it('lets the warehouse record a collection, because it hands the goods over', () => {
    expect(can('WAREHOUSE', 'record:pickup')).toBe(true);
    expect(can('SALESPERSON', 'record:pickup')).toBe(false);
    expect(can('FINANCE', 'record:pickup')).toBe(false);
  });

  it('keeps the road with the sales manager, for want of a logistics role', () => {
    // There is no dedicated logistics role in this product, and inventing one to hold four
    // permissions would be a worse answer than using the narrowest existing fit.
    for (const permission of [
      'assign:delivery',
      'dispatch:delivery',
      'complete:delivery',
      'fail:delivery',
    ] as const) {
      expect(can('SALES_MANAGER', permission)).toBe(true);
      expect(can('SALESPERSON', permission)).toBe(false);
      expect(can('FINANCE', permission)).toBe(false);
      expect(can('WAREHOUSE', permission)).toBe(false);
    }
  });

  it('lets a salesperson watch fulfilment without moving any of it', () => {
    expect(can('SALESPERSON', 'read:warehouse-task')).toBe(true);
    expect(can('SALESPERSON', 'read:delivery')).toBe(true);
    for (const permission of [
      'create:warehouse-task',
      'start:warehouse-task',
      'prepare:warehouse-task',
      'complete:warehouse-task',
      'cancel:warehouse-task',
    ] as const) {
      expect(can('SALESPERSON', permission)).toBe(false);
    }
  });

  it('lets finance see whether goods went out, and touch nothing', () => {
    // Whether an order shipped changes what to say to a debtor. It does not make finance a
    // warehouse.
    expect(can('FINANCE', 'read:warehouse-task')).toBe(true);
    expect(can('FINANCE', 'read:delivery')).toBe(true);
    expect(can('FINANCE', 'complete:warehouse-task')).toBe(false);
    expect(can('FINANCE', 'dispatch:delivery')).toBe(false);
  });

  it('keeps stock consumption away from everyone who sells', () => {
    // Consumption is the only operation that permanently removes physical quantity. Nobody who
    // negotiates a price should be able to perform it.
    for (const role of ['SALESPERSON', 'SALES_MANAGER', 'FINANCE'] as const) {
      expect(can(role, 'complete:warehouse-task')).toBe(false);
    }
  });

  it('does not let a write permission carry stock authority', () => {
    // adjust:stock is separate from write:product on purpose: the people who count the stock
    // are not the people who set the price.
    expect(can('SALES_MANAGER', 'adjust:stock')).toBe(false);
    expect(can('SALESPERSON', 'adjust:stock')).toBe(false);
    expect(can('WAREHOUSE', 'adjust:stock')).toBe(true);
    expect(can('WAREHOUSE', 'write:product')).toBe(false);
  });
});
