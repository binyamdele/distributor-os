/**
 * Roles and permissions.
 *
 * Two rules, both deliberate:
 *
 *   1. **Call sites check permissions, never roles.** A role is only ever a named bundle of
 *      permissions. `if (role === 'SALES_MANAGER')` scattered through the code is how a
 *      permission model rots — the day a distributor wants a second manager tier, every one of
 *      those checks is a place to get it wrong.
 *
 *   2. **A permission grants what its name says and nothing adjacent.** `edit:quotation` does
 *      not approve one, and approving does not send it. Payment confirmation is its
 *      own permission held only by Finance, because "can edit an order" must never quietly
 *      carry "can declare the money arrived".
 *
 * The role list mirrors the `Role` enum in schema.prisma. A test asserts the two agree, so
 * they cannot drift.
 */
export const ROLES = [
  'OWNER_ADMIN',
  'SALES_MANAGER',
  'SALESPERSON',
  'FINANCE',
  'WAREHOUSE',
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // --- Reads ---------------------------------------------------------------
  'read:dashboard',
  'read:customer',
  'read:product',
  'read:inquiry',
  'read:quotation',
  'read:order',
  'read:payment',
  'read:warehouse',
  'read:delivery',
  'read:receivables',
  'read:audit',
  'read:settings',

  // --- Writes: internal state ----------------------------------------------
  'write:customer',
  'write:product',
  'write:inquiry',
  'adjust:stock',

  // --- Phase 2: inquiry interpretation --------------------------------------
  /**
   * Run the parser over an inquiry. Separate from write:inquiry because it spends money at a
   * provider and is worth being able to withhold on its own.
   */
  'parse:inquiry',
  /**
   * Accept, correct or reject the machine's product matches. This is the permission that turns
   * a proposal into something a quotation may be built from, so it is not implied by the
   * ability to type an inquiry in.
   */
  'review:inquiry-match',
  /** Declare an inquiry ready for a quotation. The gate at the end of Phase 2. */
  'mark:inquiry-ready',

  // --- Authority, deliberately separate from the write permissions ----------
  // --- Phase 3: quotations --------------------------------------------------
  /** Draft a quotation from a reviewed inquiry. */
  'create:quotation',
  /** Change the commercial figures on a draft. Separate from creating one. */
  'edit:quotation',
  /** Put a draft in front of an approver. */
  'submit:quotation',
  /**
   * Approve a quotation whose discounts fall within a salesperson's own limit.
   *
   * Holding this is necessary but never sufficient: the rules engine decides which level a
   * given quotation requires, and a salesperson holding only this permission cannot approve one
   * that needs a manager. The permission grants the act; the rules grant the case.
   */
  'approve:quotation:self_limit',
  /** Approve a quotation whose discounts exceed the salesperson limit. */
  'approve:quotation:manager_limit',
  /** Record that an approved quotation was sent to the customer. */
  'mark:quotation-sent',

  // --- Phase 4: follow-ups, acceptance and orders ---------------------------
  'read:follow-up',
  /** Record the outcome of chasing a quotation. */
  'complete:follow-up',
  /**
   * Record that the customer accepted. Separate from creating the order, because saying what a
   * customer said and committing the organization's stock are different acts.
   */
  'record:quotation-acceptance',
  'record:quotation-rejection',
  /** Convert an accepted quotation into a sales order, reserving stock. */
  'create:sales-order',
  /** Approve AI-drafted customer-facing text before it leaves the building. */
  'approve:customer-message',
  /** Change a customer's credit standing or limit. */
  'set:customer-credit',
  'cancel:order',

  // --- Money ----------------------------------------------------------------
  // --- Phase 5: payments ----------------------------------------------------
  /**
   * Record that a customer says they paid, and attach evidence.
   *
   * Sales holds this, because sales is who the customer sends the screenshot to. It creates a
   * *claim*: it moves no money and changes no order state, which is exactly why it is a
   * different permission from confirming one.
   *
   * Finance deliberately does **not** hold it. Keeping submission and confirmation in different
   * hands means every confirmed payment has been seen by two people — which is the whole value
   * of a review gate, and is lost the moment one person can do both halves.
   */
  'submit:payment-evidence',
  /** Open the verification queue and inspect evidence. Looking is not deciding. */
  'review:payment',
  /**
   * Confirm that a payment actually arrived. Held by Finance and the owner only. This is the
   * permission that turns a claim into a fact, and nothing else implies it.
   */
  'confirm:payment',
  'reject:payment',

  // --- Fulfilment -----------------------------------------------------------
  'prepare:warehouse-task',
  'dispatch:delivery',
  'complete:delivery',

  // --- Administration -------------------------------------------------------
  'manage:users',
  'manage:settings',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const SALES_READS = [
  'read:dashboard',
  'read:customer',
  'read:product',
  'read:inquiry',
  'read:quotation',
  'read:order',
] as const satisfies readonly Permission[];

/**
 * The matrix. One place, exhaustively typed — the compiler requires every role to appear, and
 * `tests/rbac/matrix.test.ts` asserts every (role, permission) pair in both directions.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  /** The owner sees and does everything within their own organization. */
  OWNER_ADMIN: PERMISSIONS,

  SALES_MANAGER: [
    ...SALES_READS,
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
  ],

  SALESPERSON: [
    ...SALES_READS,
    'write:customer',
    'write:inquiry',
    'parse:inquiry',
    'review:inquiry-match',
    'mark:inquiry-ready',
    'create:quotation',
    'edit:quotation',
    'submit:quotation',
    /**
     * Present, but not sufficient on its own: the rules engine still refuses a discount beyond
     * the salesperson limit, at which point 'approve:quotation:manager_limit' is required and a
     * salesperson does not hold it.
     */
    'approve:quotation:self_limit',
    'mark:quotation-sent',
    'read:follow-up',
    'complete:follow-up',
    'record:quotation-acceptance',
    'record:quotation-rejection',
    'create:sales-order',
    'submit:payment-evidence',
    'approve:customer-message',
  ],

  FINANCE: [
    'read:dashboard',
    'read:customer',
    /**
     * Read only. Finance chases what was quoted and what is owed; they do not set prices, and
     * granting a write here "so the numbers can be fixed" is how a separation of duties dies.
     */
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
  ],

  WAREHOUSE: [
    'read:dashboard',
    'read:order',
    'read:product',
    'read:warehouse',
    'read:delivery',
    /**
     * Warehouse staff are the people who actually count the stock, so they are the people who
     * correct it. Note this does not carry 'write:product': they can say how many bags are on
     * the floor, and cannot change what a bag costs.
     */
    'adjust:stock',
    'prepare:warehouse-task',
    'dispatch:delivery',
    'complete:delivery',
  ],
};

const PERMISSION_SETS = ROLES.reduce(
  (acc, role) => {
    acc[role] = new Set(ROLE_PERMISSIONS[role]);
    return acc;
  },
  {} as Record<Role, ReadonlySet<Permission>>,
);

export function can(role: Role, permission: Permission): boolean {
  return PERMISSION_SETS[role].has(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** Human-readable role names for the UI. Keys, not sentences — the i18n catalogue holds the copy. */
export const ROLE_LABEL_KEYS: Readonly<Record<Role, string>> = {
  OWNER_ADMIN: 'role.ownerAdmin',
  SALES_MANAGER: 'role.salesManager',
  SALESPERSON: 'role.salesperson',
  FINANCE: 'role.finance',
  WAREHOUSE: 'role.warehouse',
};
