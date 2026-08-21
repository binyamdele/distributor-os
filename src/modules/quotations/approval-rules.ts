import { type PricedLineInput, deepestDiscountBp, linesBelowFloor } from './pricing';

/**
 * The approval rules engine.
 *
 * Deterministic, pure, and small on purpose. The brief asks for a simple configurable engine
 * rather than a general-purpose workflow language, and the difference matters: everything below
 * can be enumerated in a unit test, which a rules DSL could not be.
 *
 * Nothing here consults a model. Approval authority is policy, and policy is not a thing to
 * infer from text.
 */

export type ApprovalLevel = 'SALESPERSON' | 'SALES_MANAGER' | 'BLOCKED';

export interface ApprovalPolicy {
  readonly salespersonDiscountLimitBp: number;
  readonly salesManagerDiscountLimitBp: number;
  /** A floor on the quoted price as a fraction of list. 9000 = never below 90% of list. */
  readonly minimumPriceFloorBp: number;
}

export type CreditStatus = 'CASH_ONLY' | 'CREDIT_ALLOWED' | 'SUSPENDED';
export type PaymentType = 'CASH' | 'CREDIT';

export interface ApprovalInput {
  readonly lines: readonly PricedLineInput[];
  readonly paymentType: PaymentType;
  readonly paymentTermsDays: number;
  readonly customerCreditStatus: CreditStatus;
  /** The credit days this customer has actually been granted. 0 means none. */
  readonly customerPaymentTermsDays: number;
  readonly policy: ApprovalPolicy;
}

/** A machine-readable reason, so the UI can render it and a test can assert on it. */
export type ApprovalReasonCode =
  | 'DISCOUNT_WITHIN_SALESPERSON_LIMIT'
  | 'DISCOUNT_ABOVE_SALESPERSON_LIMIT'
  | 'DISCOUNT_ABOVE_MANAGER_LIMIT'
  | 'PRICE_BELOW_FLOOR'
  | 'CREDIT_REFUSED_CASH_ONLY_CUSTOMER'
  | 'CREDIT_REFUSED_SUSPENDED_CUSTOMER'
  | 'CREDIT_TERMS_EXCEED_CUSTOMER_LIMIT'
  | 'NO_ITEMS';

export interface ApprovalReason {
  readonly code: ApprovalReasonCode;
  readonly message: string;
  /** Set when the reason belongs to a particular line. */
  readonly lineIndex?: number;
}

export interface ApprovalRequirement {
  readonly level: ApprovalLevel;
  readonly reasons: readonly ApprovalReason[];
  /** True when nobody can approve as things stand and the quotation must change instead. */
  readonly blocked: boolean;
  readonly deepestDiscountBp: number;
}

function bpToPercent(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.00$/, '')}%`;
}

/**
 * Decides who, if anyone, may approve.
 *
 * Every quotation needs an approval before it can be sent — there is no "no approval required"
 * outcome. What the rules decide is *whose* signature is sufficient, which is the question a
 * distributor actually has.
 *
 * The rules, in the brief's lettering:
 *
 *   A  discount ≤ salesperson limit                 → SALESPERSON
 *   B  discount ≤ manager limit                     → SALES_MANAGER
 *   C  discount > manager limit                     → BLOCKED
 *   D  quoted price below the floor                 → BLOCKED
 *   E  credit terms for a SUSPENDED customer        → BLOCKED (a *cash* quote stays fine)
 *   F  credit terms for a CASH_ONLY customer        → BLOCKED (a *cash* quote stays fine)
 *
 * Rule C blocks rather than escalating to the owner. The brief prefers blocking, and the
 * reasoning holds: a discount past the manager ceiling is a pricing decision the organization
 * has already said it does not want made line by line. The remedy is to change the number, not
 * to find a bigger signature. An owner who genuinely wants it can raise the configured limit,
 * which is a deliberate, audited act rather than a one-off override buried in a quotation.
 *
 * Rules E and F are deliberately narrow. A suspended customer is not a customer you cannot
 * sell to — it is a customer you cannot lend to. Blocking the whole quotation would be a
 * misreading that costs a distributor real business.
 */
export function evaluateApproval(input: ApprovalInput): ApprovalRequirement {
  const reasons: ApprovalReason[] = [];
  const { policy } = input;

  if (input.lines.length === 0) {
    return {
      level: 'BLOCKED',
      blocked: true,
      deepestDiscountBp: 0,
      reasons: [{ code: 'NO_ITEMS', message: 'A quotation with no lines cannot be approved.' }],
    };
  }

  const deepest = deepestDiscountBp(input.lines);
  let level: ApprovalLevel = 'SALESPERSON';

  // --- Rules A, B, C: the discount ladder -----------------------------------
  if (deepest > policy.salesManagerDiscountLimitBp) {
    level = 'BLOCKED';
    reasons.push({
      code: 'DISCOUNT_ABOVE_MANAGER_LIMIT',
      message:
        `A discount of ${bpToPercent(deepest)} exceeds the ${bpToPercent(
          policy.salesManagerDiscountLimitBp,
        )} ceiling. Reduce the discount, or have the limit raised in settings.`,
    });
  } else if (deepest > policy.salespersonDiscountLimitBp) {
    level = 'SALES_MANAGER';
    reasons.push({
      code: 'DISCOUNT_ABOVE_SALESPERSON_LIMIT',
      message:
        `A discount of ${bpToPercent(deepest)} is above the ${bpToPercent(
          policy.salespersonDiscountLimitBp,
        )} a salesperson may approve, so a sales manager must sign this off.`,
    });
  } else {
    reasons.push({
      code: 'DISCOUNT_WITHIN_SALESPERSON_LIMIT',
      message:
        deepest === 0
          ? 'No discount has been given.'
          : `The deepest discount is ${bpToPercent(deepest)}, within a salesperson's authority.`,
    });
  }

  // --- Rule D: the price floor, checked independently of the ladder ---------
  //
  // Independently, because the two are separately configurable. They coincide at 10% under the
  // default settings, but an organization can set a 5% floor with a 10% manager limit, and then
  // a 7% discount is inside the ladder and through the floor at the same time.
  for (const lineIndex of linesBelowFloor(input.lines, policy.minimumPriceFloorBp)) {
    level = 'BLOCKED';
    reasons.push({
      code: 'PRICE_BELOW_FLOOR',
      lineIndex,
      message:
        `Line ${lineIndex + 1} is priced below the ${bpToPercent(
          policy.minimumPriceFloorBp,
        )} floor set for this organization.`,
    });
  }

  // --- Rules E and F: credit eligibility ------------------------------------
  if (input.paymentType === 'CREDIT') {
    if (input.customerCreditStatus === 'SUSPENDED') {
      level = 'BLOCKED';
      reasons.push({
        code: 'CREDIT_REFUSED_SUSPENDED_CUSTOMER',
        message:
          'This customer’s credit is suspended, so credit terms cannot be offered. A cash quotation is still allowed.',
      });
    } else if (input.customerCreditStatus === 'CASH_ONLY') {
      level = 'BLOCKED';
      reasons.push({
        code: 'CREDIT_REFUSED_CASH_ONLY_CUSTOMER',
        message:
          'This customer is cash-only, so credit terms cannot be offered. A cash quotation is still allowed.',
      });
    } else if (
      input.customerPaymentTermsDays > 0 &&
      input.paymentTermsDays > input.customerPaymentTermsDays
    ) {
      level = 'BLOCKED';
      reasons.push({
        code: 'CREDIT_TERMS_EXCEED_CUSTOMER_LIMIT',
        message:
          `This quotation offers ${input.paymentTermsDays} days, beyond the ${input.customerPaymentTermsDays} ` +
          'agreed with this customer.',
      });
    }
  }

  return {
    level,
    blocked: level === 'BLOCKED',
    reasons,
    deepestDiscountBp: deepest,
  };
}

/** Which roles can satisfy a required level. Consulted alongside the permission matrix. */
export function rolesSatisfying(level: ApprovalLevel): readonly string[] {
  switch (level) {
    case 'SALESPERSON':
      return ['SALESPERSON', 'SALES_MANAGER', 'OWNER_ADMIN'];
    case 'SALES_MANAGER':
      return ['SALES_MANAGER', 'OWNER_ADMIN'];
    case 'BLOCKED':
      return [];
  }
}
