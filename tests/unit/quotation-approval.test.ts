import { describe, expect, it } from 'vitest';
import {
  type ApprovalInput,
  evaluateApproval,
  rolesSatisfying,
} from '@/modules/quotations/approval-rules';
import type { PricedLineInput } from '@/modules/quotations/pricing';
import {
  QUOTATION_STATUSES,
  type QuotationStatus,
  allowedTransitions,
  canTransition,
  isEditable,
  isTerminal,
  withdrawsApproval,
} from '@/modules/quotations/state';
import { buildApprovalPayload, approvalPayloadHash } from '@/modules/quotations/payload';
import { formatDocumentNumber } from '@/modules/numbering';

const POLICY = {
  salespersonDiscountLimitBp: 300,
  salesManagerDiscountLimitBp: 1000,
  minimumPriceFloorBp: 9000,
};

function line(discountBp = 0): PricedLineInput {
  return {
    quantity: 10,
    listUnitPriceMinor: 100_00n,
    quotedUnitPriceMinor: 100_00n,
    discountBp,
    taxRateBp: 1500,
  };
}

function input(overrides: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    lines: [line()],
    paymentType: 'CASH',
    paymentTermsDays: 0,
    customerCreditStatus: 'CREDIT_ALLOWED',
    customerPaymentTermsDays: 30,
    policy: POLICY,
    ...overrides,
  };
}

describe('the discount ladder', () => {
  it('lets a salesperson approve with no discount', () => {
    const result = evaluateApproval(input());
    expect(result.level).toBe('SALESPERSON');
    expect(result.blocked).toBe(false);
  });

  it('lets a salesperson approve exactly at their limit', () => {
    const result = evaluateApproval(input({ lines: [line(300)] }));
    expect(result.level).toBe('SALESPERSON');
  });

  it('escalates one basis point above the salesperson limit', () => {
    const result = evaluateApproval(input({ lines: [line(301)] }));
    expect(result.level).toBe('SALES_MANAGER');
    expect(result.reasons.map((r) => r.code)).toContain('DISCOUNT_ABOVE_SALESPERSON_LIMIT');
  });

  it('still allows a manager exactly at the manager limit', () => {
    const result = evaluateApproval(input({ lines: [line(1000)] }));
    expect(result.level).toBe('SALES_MANAGER');
    expect(result.blocked).toBe(false);
  });

  it('blocks one basis point above the manager limit', () => {
    const result = evaluateApproval(input({ lines: [line(1001)] }));
    expect(result.level).toBe('BLOCKED');
    expect(result.blocked).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain('DISCOUNT_ABOVE_MANAGER_LIMIT');
  });

  it('blocks rather than escalating to the owner', () => {
    // The documented MVP policy: past the manager ceiling there is no bigger signature, only a
    // different number or a deliberate change to the configured limit.
    const result = evaluateApproval(input({ lines: [line(5000)] }));
    expect(rolesSatisfying(result.level)).toEqual([]);
  });

  it('is driven by the deepest line, not an average', () => {
    const result = evaluateApproval(input({ lines: [line(0), line(0), line(900)] }));
    expect(result.level).toBe('SALES_MANAGER');
    expect(result.deepestDiscountBp).toBe(900);
  });

  it('refuses a quotation with no lines', () => {
    const result = evaluateApproval(input({ lines: [] }));
    expect(result.blocked).toBe(true);
    expect(result.reasons[0]?.code).toBe('NO_ITEMS');
  });
});

describe('the price floor', () => {
  it('passes a line exactly at the floor', () => {
    // 10% off leaves 90% of list, which is exactly the 9000bp floor.
    const result = evaluateApproval(input({ lines: [line(1000)] }));
    expect(result.reasons.map((r) => r.code)).not.toContain('PRICE_BELOW_FLOOR');
  });

  it('blocks one basis point below the floor', () => {
    const result = evaluateApproval(input({ lines: [line(1001)] }));
    expect(result.reasons.map((r) => r.code)).toContain('PRICE_BELOW_FLOOR');
    expect(result.blocked).toBe(true);
  });

  it('is checked independently of the discount ladder', () => {
    // A 5% floor with a 10% manager limit: 7% is inside the ladder and through the floor.
    const result = evaluateApproval(
      input({
        lines: [line(700)],
        policy: { ...POLICY, minimumPriceFloorBp: 9500 },
      }),
    );
    expect(result.reasons.map((r) => r.code)).toContain('DISCOUNT_ABOVE_SALESPERSON_LIMIT');
    expect(result.reasons.map((r) => r.code)).toContain('PRICE_BELOW_FLOOR');
    expect(result.blocked).toBe(true);
  });

  it('names the offending line', () => {
    const result = evaluateApproval(input({ lines: [line(0), line(9000)] }));
    const breach = result.reasons.find((r) => r.code === 'PRICE_BELOW_FLOOR');
    expect(breach?.lineIndex).toBe(1);
  });
});

describe('credit eligibility', () => {
  it('allows a cash quotation for a suspended customer', () => {
    // The distinction the brief insists on: suspended credit is not "cannot sell".
    const result = evaluateApproval(
      input({ customerCreditStatus: 'SUSPENDED', paymentType: 'CASH' }),
    );
    expect(result.blocked).toBe(false);
    expect(result.level).toBe('SALESPERSON');
  });

  it('blocks credit terms for a suspended customer', () => {
    const result = evaluateApproval(
      input({ customerCreditStatus: 'SUSPENDED', paymentType: 'CREDIT', paymentTermsDays: 30 }),
    );
    expect(result.blocked).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain('CREDIT_REFUSED_SUSPENDED_CUSTOMER');
  });

  it('allows a cash quotation for a cash-only customer', () => {
    const result = evaluateApproval(
      input({ customerCreditStatus: 'CASH_ONLY', paymentType: 'CASH' }),
    );
    expect(result.blocked).toBe(false);
  });

  it('blocks credit terms for a cash-only customer', () => {
    const result = evaluateApproval(
      input({ customerCreditStatus: 'CASH_ONLY', paymentType: 'CREDIT', paymentTermsDays: 7 }),
    );
    expect(result.blocked).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain('CREDIT_REFUSED_CASH_ONLY_CUSTOMER');
  });

  it('allows credit within the customer’s agreed terms', () => {
    const result = evaluateApproval(
      input({ paymentType: 'CREDIT', paymentTermsDays: 30, customerPaymentTermsDays: 30 }),
    );
    expect(result.blocked).toBe(false);
  });

  it('blocks credit beyond the customer’s agreed terms', () => {
    const result = evaluateApproval(
      input({ paymentType: 'CREDIT', paymentTermsDays: 30, customerPaymentTermsDays: 15 }),
    );
    expect(result.blocked).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain('CREDIT_TERMS_EXCEED_CUSTOMER_LIMIT');
  });

  it('does not apply a customer limit of zero as a ceiling', () => {
    // A credit-allowed customer with no recorded term is not thereby limited to zero days.
    const result = evaluateApproval(
      input({ paymentType: 'CREDIT', paymentTermsDays: 30, customerPaymentTermsDays: 0 }),
    );
    expect(result.blocked).toBe(false);
  });
});

describe('who may approve what', () => {
  it('lets a salesperson, a manager or the owner satisfy the salesperson level', () => {
    expect(rolesSatisfying('SALESPERSON')).toEqual(['SALESPERSON', 'SALES_MANAGER', 'OWNER_ADMIN']);
  });

  it('excludes a salesperson from the manager level', () => {
    expect(rolesSatisfying('SALES_MANAGER')).not.toContain('SALESPERSON');
  });

  it('lets nobody satisfy a blocked quotation', () => {
    expect(rolesSatisfying('BLOCKED')).toEqual([]);
  });
});

describe('the quotation state machine', () => {
  it('permits exactly the documented transitions', () => {
    const expected: Record<QuotationStatus, QuotationStatus[]> = {
      DRAFT: ['PENDING_APPROVAL', 'CANCELLED', 'EXPIRED'],
      PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
      APPROVED: ['SENT', 'DRAFT', 'CANCELLED', 'EXPIRED'],
      SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'],
      ACCEPTED: ['SUPERSEDED'],
      REJECTED: ['SUPERSEDED'],
      EXPIRED: ['SUPERSEDED'],
      SUPERSEDED: [],
      CANCELLED: [],
    };

    for (const from of QUOTATION_STATUSES) {
      for (const to of QUOTATION_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected[from].includes(to));
      }
    }
  });

  it('sends an invalidated approval back to draft, not back into the queue', () => {
    expect(canTransition('APPROVED', 'DRAFT')).toBe(true);
    expect(canTransition('APPROVED', 'PENDING_APPROVAL')).toBe(false);
  });

  it('does not let a draft skip approval', () => {
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition('DRAFT', 'SENT')).toBe(false);
  });

  it('does not let an unapproved quotation be sent', () => {
    expect(canTransition('PENDING_APPROVAL', 'SENT')).toBe(false);
  });

  it('does not let a sent quotation be edited back into draft', () => {
    expect(canTransition('SENT', 'DRAFT')).toBe(false);
    expect(allowedTransitions('SENT')).toContain('SUPERSEDED');
  });

  it('treats superseded and cancelled as terminal', () => {
    expect(isTerminal('SUPERSEDED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
  });

  it('knows which states accept an edit', () => {
    expect(isEditable('DRAFT')).toBe(true);
    expect(isEditable('PENDING_APPROVAL')).toBe(true);
    expect(isEditable('APPROVED')).toBe(true);
    expect(isEditable('SENT')).toBe(false);
    expect(isEditable('CANCELLED')).toBe(false);
  });

  it('knows which states lose an approval on edit', () => {
    expect(withdrawsApproval('APPROVED')).toBe(true);
    expect(withdrawsApproval('PENDING_APPROVAL')).toBe(true);
    expect(withdrawsApproval('DRAFT')).toBe(false);
  });
});

describe('document numbering format', () => {
  it('pads to six digits', () => {
    expect(formatDocumentNumber('QUOTATION', 1n)).toBe('Q-000001');
    expect(formatDocumentNumber('QUOTATION', 42n)).toBe('Q-000042');
    expect(formatDocumentNumber('QUOTATION', 999_999n)).toBe('Q-999999');
  });

  it('widens rather than wrapping', () => {
    expect(formatDocumentNumber('QUOTATION', 1_000_000n)).toBe('Q-1000000');
  });

  it('uses a different prefix for orders', () => {
    expect(formatDocumentNumber('ORDER', 1n)).toBe('SO-000001');
  });
});

describe('the approval payload hash', () => {
  const base = {
    organizationId: 'org-1',
    quotationId: 'quote-1',
    customerId: 'customer-1',
    customerCreditStatus: 'CREDIT_ALLOWED',
    currency: 'ETB',
    paymentType: 'CASH',
    paymentTermsDays: 0,
    validityDate: new Date('2026-09-01T00:00:00.000Z'),
    deliveryFeeMinor: 450_000n,
    deliveryTaxMinor: 67_500n,
    subtotalMinor: 787_850_00n,
    discountTotalMinor: 284_000n,
    taxTotalMinor: 118_177_50n,
    grandTotalMinor: 906_027_50n,
    lines: [
      {
        productId: 'product-1',
        sku: 'CEM-OPC-50',
        description: 'OPC Cement 50kg',
        unit: 'bag',
        quantity: 500,
        listUnitPriceMinor: 125_000n,
        quotedUnitPriceMinor: 125_000n,
        discountBp: 0,
        taxRateBp: 1500,
        lineSubtotalMinor: 625_000_00n,
        lineDiscountMinor: 0n,
        taxableAmountMinor: 625_000_00n,
        taxMinor: 93_750_00n,
        lineTotalMinor: 718_750_00n,
        sortOrder: 0,
      },
    ],
  };

  const hashOf = (overrides: Partial<typeof base> = {}) =>
    approvalPayloadHash(buildApprovalPayload({ ...base, ...overrides }));

  it('is stable across repeated calls', () => {
    expect(hashOf()).toBe(hashOf());
  });

  it('is stable across a re-serialisation that changes key order', () => {
    const reordered = buildApprovalPayload({
      ...base,
      lines: base.lines.map((l) => ({ ...l })),
    });
    expect(approvalPayloadHash(reordered)).toBe(hashOf());
  });

  it('does not depend on the order lines happen to be loaded in', () => {
    const twoLines = {
      ...base,
      lines: [
        { ...base.lines[0]!, sortOrder: 0 },
        { ...base.lines[0]!, sku: 'RB-12', sortOrder: 1 },
      ],
    };
    const reversed = { ...twoLines, lines: [...twoLines.lines].reverse() };
    expect(approvalPayloadHash(buildApprovalPayload(twoLines))).toBe(
      approvalPayloadHash(buildApprovalPayload(reversed)),
    );
  });

  describe('changes when an approval-sensitive field changes', () => {
    const cases: [string, Partial<typeof base>][] = [
      ['quantity', { lines: [{ ...base.lines[0]!, quantity: 501 }] }],
      ['quoted price', { lines: [{ ...base.lines[0]!, quotedUnitPriceMinor: 125_001n }] }],
      ['list price', { lines: [{ ...base.lines[0]!, listUnitPriceMinor: 125_001n }] }],
      ['discount', { lines: [{ ...base.lines[0]!, discountBp: 250 }] }],
      ['tax rate', { lines: [{ ...base.lines[0]!, taxRateBp: 0 }] }],
      ['a computed line amount', { lines: [{ ...base.lines[0]!, lineTotalMinor: 1n }] }],
      ['the product', { lines: [{ ...base.lines[0]!, productId: 'product-2' }] }],
      ['the customer', { customerId: 'customer-2' }],
      ['credit standing', { customerCreditStatus: 'SUSPENDED' }],
      ['payment type', { paymentType: 'CREDIT' }],
      ['payment terms', { paymentTermsDays: 30 }],
      ['delivery fee', { deliveryFeeMinor: 450_001n }],
      ['delivery tax', { deliveryTaxMinor: 1n }],
      ['validity date', { validityDate: new Date('2026-09-02T00:00:00.000Z') }],
      ['subtotal', { subtotalMinor: 1n }],
      ['discount total', { discountTotalMinor: 1n }],
      ['tax total', { taxTotalMinor: 1n }],
      ['grand total', { grandTotalMinor: 1n }],
      ['an added line', { lines: [...base.lines, { ...base.lines[0]!, sku: 'RB-12', sortOrder: 1 }] }],
      ['a removed line', { lines: [] }],
      ['the organization', { organizationId: 'org-2' }],
    ];

    for (const [what, overrides] of cases) {
      it(what, () => {
        expect(hashOf(overrides)).not.toBe(hashOf());
      });
    }
  });

  it('does not change when the time of day on the validity date changes', () => {
    // A validity date is a calendar date. Hashing the timestamp would make an approval depend
    // on which machine wrote the row.
    expect(hashOf({ validityDate: new Date('2026-09-01T18:30:00.000Z') })).toBe(hashOf());
  });

  it('cannot be reused across organizations', () => {
    expect(hashOf({ organizationId: 'org-2' })).not.toBe(hashOf());
  });

  it('does not confuse a bigint amount with its string spelling', () => {
    // The reason hashPayload type-tags rather than JSON.stringify-ing: money is bigint.
    const asString = buildApprovalPayload({
      ...base,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      grandTotalMinor: '90602750' as any,
    });
    expect(approvalPayloadHash(asString)).not.toBe(hashOf());
  });
});
