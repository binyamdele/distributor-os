import 'server-only';
import { z } from 'zod';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { type Result, fail, ok } from '@/platform/result';
import type { Role } from '@/platform/rbac';
import { recordAudit } from '@/modules/audit';
import { allocateDocumentNumber } from '@/modules/numbering';
import { cancelOpenFollowUps, scheduleFirstFollowUp } from '@/modules/followups';
import { freeStock } from '@/modules/catalog';
import {
  type ApprovalLevel,
  type ApprovalRequirement,
  evaluateApproval,
  rolesSatisfying,
} from './approval-rules';
import {
  type PricedLineInput,
  calculateTotals,
  effectiveUnitPrice,
  reconciles,
} from './pricing';
import { type ApprovalPayload, approvalPayloadHash, buildApprovalPayload } from './payload';
import { type QuotationStatus, canTransition, isEditable, withdrawsApproval } from './state';

export * from './state';
export * from './pricing';
export * from './approval-rules';
export * from './payload';

export const PAYMENT_TYPES = ['CASH', 'CREDIT'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

/** The narrow MVP set of credit terms. Anything else is a settings change, not a quotation. */
export const CREDIT_TERM_DAYS = [7, 15, 30] as const;

const DEFAULT_POLICY = {
  salespersonDiscountLimitBp: 300,
  salesManagerDiscountLimitBp: 1000,
  minimumPriceFloorBp: 9000,
  quoteValidityDays: 7,
  defaultPaymentTermsDays: 30,
  deliveryFeeTaxable: true,
  followUpIntervalDays: 2,
};

// ---------------------------------------------------------------------------
// Loading and recalculation
// ---------------------------------------------------------------------------

/**
 * Takes the row lock.
 *
 * Every mutation and every decision goes through here first, so an edit and an approval racing
 * each other are serialised by the database rather than by the order two HTTP requests happened
 * to arrive in. Without it, the sequence "read status, decide, write" can interleave with
 * another such sequence and leave an approval attached to figures nobody approved.
 */
async function lockQuotation(
  tx: TenantTransaction,
  organizationId: string,
  quotationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM quotations
     WHERE id = ${quotationId}::uuid
       AND organization_id = ${organizationId}::uuid
     FOR UPDATE
  `;
  return rows.length > 0;
}

interface LoadedQuotation {
  quotation: {
    id: string;
    organizationId: string;
    quotationNumber: string;
    status: QuotationStatus;
    currency: string;
    customerId: string;
    inquiryId: string | null;
    paymentType: PaymentType;
    paymentTermsDays: number;
    deliveryFeeMinor: bigint;
    validityDate: Date;
    customerNotes: string | null;
    internalNotes: string | null;
    approvedPayloadHash: string | null;
    currentPayloadHash: string;
    approvedById: string | null;
    approvedAt: Date | null;
    sentAt: Date | null;
  };
  customer: { id: string; companyName: string; creditStatus: string; paymentTermsDays: number };
  items: {
    id: string;
    productId: string | null;
    skuSnapshot: string;
    descriptionSnapshot: string;
    unitSnapshot: string;
    quantity: number;
    listUnitPriceMinor: bigint;
    quotedUnitPriceMinor: bigint;
    discountBp: number;
    taxRateBp: number;
    sortOrder: number;
  }[];
  policy: {
    salespersonDiscountLimitBp: number;
    salesManagerDiscountLimitBp: number;
    minimumPriceFloorBp: number;
    deliveryFeeTaxable: boolean;
    quoteValidityDays: number;
    defaultPaymentTermsDays: number;
    followUpIntervalDays: number;
  };
  vatRateBp: number;
}

async function load(
  tx: TenantTransaction,
  quotationId: string,
): Promise<LoadedQuotation | null> {
  const quotation = await tx.quotation.findFirst({
    where: { id: quotationId },
    include: {
      customer: true,
      items: { orderBy: { sortOrder: 'asc' } },
      organization: { include: { settings: true } },
    },
  });
  if (!quotation) return null;

  const settings = quotation.organization.settings;

  return {
    quotation: {
      id: quotation.id,
      organizationId: quotation.organizationId,
      quotationNumber: quotation.quotationNumber,
      status: quotation.status as QuotationStatus,
      currency: quotation.currency,
      customerId: quotation.customerId,
      inquiryId: quotation.inquiryId,
      paymentType: quotation.paymentType as PaymentType,
      paymentTermsDays: quotation.paymentTermsDays,
      deliveryFeeMinor: quotation.deliveryFeeMinor,
      validityDate: quotation.validityDate,
      customerNotes: quotation.customerNotes,
      internalNotes: quotation.internalNotes,
      approvedPayloadHash: quotation.approvedPayloadHash,
      currentPayloadHash: quotation.currentPayloadHash,
      approvedById: quotation.approvedById,
      approvedAt: quotation.approvedAt,
      sentAt: quotation.sentAt,
    },
    customer: {
      id: quotation.customer.id,
      companyName: quotation.customer.companyName,
      creditStatus: quotation.customer.creditStatus,
      paymentTermsDays: quotation.customer.paymentTermsDays,
    },
    items: quotation.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      skuSnapshot: item.skuSnapshot,
      descriptionSnapshot: item.descriptionSnapshot,
      unitSnapshot: item.unitSnapshot,
      quantity: item.quantity,
      listUnitPriceMinor: item.listUnitPriceMinor,
      quotedUnitPriceMinor: item.quotedUnitPriceMinor,
      discountBp: item.discountBp,
      taxRateBp: item.taxRateBp,
      sortOrder: item.sortOrder,
    })),
    policy: {
      salespersonDiscountLimitBp:
        settings?.salespersonDiscountLimitBp ?? DEFAULT_POLICY.salespersonDiscountLimitBp,
      salesManagerDiscountLimitBp:
        settings?.salesManagerDiscountLimitBp ?? DEFAULT_POLICY.salesManagerDiscountLimitBp,
      minimumPriceFloorBp: settings?.minimumPriceFloorBp ?? DEFAULT_POLICY.minimumPriceFloorBp,
      deliveryFeeTaxable: settings?.deliveryFeeTaxable ?? DEFAULT_POLICY.deliveryFeeTaxable,
      quoteValidityDays: settings?.quoteValidityDays ?? DEFAULT_POLICY.quoteValidityDays,
      defaultPaymentTermsDays:
        settings?.defaultPaymentTermsDays ?? DEFAULT_POLICY.defaultPaymentTermsDays,
      followUpIntervalDays:
        settings?.followUpIntervalDays ?? DEFAULT_POLICY.followUpIntervalDays,
    },
    vatRateBp: quotation.organization.vatRateBp,
  };
}

export interface RecalculationResult {
  readonly totals: ReturnType<typeof calculateTotals>;
  readonly requirement: ApprovalRequirement;
  readonly payload: ApprovalPayload;
  readonly payloadHash: string;
}

/**
 * Recomputes every derived figure from the persisted rows and writes them back.
 *
 * Called after every mutation and again, inside the lock, before every decision. Deriving the
 * hash from what is actually stored — rather than trusting a value carried along from an
 * earlier read — is what makes the approval binding survive a race: an approval that runs after
 * a committed edit hashes the edited figures and therefore refuses.
 */
async function recalculate(
  tx: TenantTransaction,
  loaded: LoadedQuotation,
): Promise<RecalculationResult> {
  const lineInputs: PricedLineInput[] = loaded.items.map((item) => ({
    quantity: item.quantity,
    listUnitPriceMinor: item.listUnitPriceMinor,
    quotedUnitPriceMinor: item.quotedUnitPriceMinor,
    discountBp: item.discountBp,
    taxRateBp: item.taxRateBp,
  }));

  const totals = calculateTotals({
    currency: loaded.quotation.currency,
    lines: lineInputs,
    deliveryFeeMinor: loaded.quotation.deliveryFeeMinor,
    deliveryFeeTaxable: loaded.policy.deliveryFeeTaxable,
    vatRateBp: loaded.vatRateBp,
  });

  if (!reconciles(totals)) {
    // Not a rounding preference. A quotation whose parts do not add up to its whole must stop
    // here rather than reach a customer.
    throw new Error(`quotation ${loaded.quotation.quotationNumber} totals do not reconcile`);
  }

  const requirement = evaluateApproval({
    lines: lineInputs,
    paymentType: loaded.quotation.paymentType,
    paymentTermsDays: loaded.quotation.paymentTermsDays,
    customerCreditStatus: loaded.customer.creditStatus as 'CASH_ONLY',
    customerPaymentTermsDays: loaded.customer.paymentTermsDays,
    policy: loaded.policy,
  });

  const payload = buildApprovalPayload({
    organizationId: loaded.quotation.organizationId,
    quotationId: loaded.quotation.id,
    customerId: loaded.quotation.customerId,
    customerCreditStatus: loaded.customer.creditStatus,
    currency: loaded.quotation.currency,
    paymentType: loaded.quotation.paymentType,
    paymentTermsDays: loaded.quotation.paymentTermsDays,
    validityDate: loaded.quotation.validityDate,
    deliveryFeeMinor: totals.deliveryFeeMinor,
    deliveryTaxMinor: totals.deliveryTaxMinor,
    subtotalMinor: totals.subtotalMinor,
    discountTotalMinor: totals.discountTotalMinor,
    taxTotalMinor: totals.taxTotalMinor,
    grandTotalMinor: totals.grandTotalMinor,
    lines: loaded.items.map((item, index) => ({
      productId: item.productId,
      sku: item.skuSnapshot,
      description: item.descriptionSnapshot,
      unit: item.unitSnapshot,
      quantity: item.quantity,
      listUnitPriceMinor: item.listUnitPriceMinor,
      quotedUnitPriceMinor: item.quotedUnitPriceMinor,
      discountBp: item.discountBp,
      taxRateBp: item.taxRateBp,
      lineSubtotalMinor: totals.lines[index]!.lineSubtotalMinor,
      lineDiscountMinor: totals.lines[index]!.lineDiscountMinor,
      taxableAmountMinor: totals.lines[index]!.taxableAmountMinor,
      taxMinor: totals.lines[index]!.taxMinor,
      lineTotalMinor: totals.lines[index]!.lineTotalMinor,
      sortOrder: item.sortOrder,
    })),
  });

  const payloadHash = approvalPayloadHash(payload);

  // Persist the derived line amounts, so the stored figures and the displayed figures cannot
  // drift apart and so a report never has to recompute them.
  for (const [index, item] of loaded.items.entries()) {
    const priced = totals.lines[index]!;
    await tx.quotationItem.update({
      where: { id: item.id },
      data: {
        lineSubtotalMinor: priced.lineSubtotalMinor,
        lineDiscountMinor: priced.lineDiscountMinor,
        taxableAmountMinor: priced.taxableAmountMinor,
        taxMinor: priced.taxMinor,
        lineTotalMinor: priced.lineTotalMinor,
      },
    });
  }

  await tx.quotation.update({
    where: { id: loaded.quotation.id },
    data: {
      subtotalMinor: totals.subtotalMinor,
      discountTotalMinor: totals.discountTotalMinor,
      deliveryTaxMinor: totals.deliveryTaxMinor,
      taxTotalMinor: totals.taxTotalMinor,
      grandTotalMinor: totals.grandTotalMinor,
      currentPayloadHash: payloadHash,
      requiredLevel: requirement.level,
    },
  });

  return { totals, requirement, payload, payloadHash };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export const createQuotationSchema = z.object({
  inquiryId: z.string().uuid(),
  paymentType: z.enum(PAYMENT_TYPES).default('CASH'),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(0),
});

function addDays(base: Date, days: number): Date {
  const result = new Date(base.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

/**
 * Drafts a quotation from a reviewed inquiry.
 *
 * The only source of a line is `matchedProductId` — the human's decision. `proposedProductId`
 * is the machine's opinion and is never read here, which is the whole reason Phase 2 kept the
 * two apart.
 */
export async function createFromInquiry(
  tx: TenantTransaction,
  context: ActorContext,
  raw: unknown,
): Promise<Result<{ id: string; quotationNumber: string }>> {
  const parsed = createQuotationSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'error.generic');
  }
  const input = parsed.data;

  const inquiry = await tx.inquiry.findFirst({
    where: { id: input.inquiryId },
    include: { items: { orderBy: { position: 'asc' } }, customer: true },
  });
  if (!inquiry) return fail('NOT_FOUND', 'error.notFound');

  if (inquiry.status !== 'READY_FOR_QUOTE') {
    return fail(
      'INVALID_STATE_TRANSITION',
      'Only an inquiry that has been reviewed and marked ready can become a quotation.',
    );
  }
  if (!inquiry.customerId || !inquiry.customer) {
    return fail(
      'VALIDATION_FAILED',
      'This inquiry is not linked to a customer. Attach one before quoting.',
    );
  }

  const retained = inquiry.items.filter((item) => item.reviewStatus !== 'REJECTED');
  if (retained.length === 0) {
    return fail('VALIDATION_FAILED', 'This inquiry has no lines left to quote.');
  }
  if (retained.some((item) => !item.matchedProductId)) {
    // Belt and braces: the readiness gate already refuses this, but a quotation built from an
    // unconfirmed match is exactly the failure the two-column design exists to prevent.
    return fail(
      'VALIDATION_FAILED',
      'Every line must have a confirmed product before a quotation can be drafted.',
    );
  }

  const organization = await tx.organization.findFirst({
    where: { id: context.organizationId },
    include: { settings: true },
  });
  if (!organization) return fail('NOT_FOUND', 'error.notFound');

  const validityDays = organization.settings?.quoteValidityDays ?? DEFAULT_POLICY.quoteValidityDays;

  // Credit terms are validated by the rules engine at approval time, but refusing them at
  // creation gives a clearer error than a blocked approval three screens later.
  const eligible = inquiry.customer.creditStatus === 'CREDIT_ALLOWED';
  const paymentType: PaymentType = input.paymentType === 'CREDIT' && eligible ? 'CREDIT' : 'CASH';
  const paymentTermsDays = paymentType === 'CREDIT' ? input.paymentTermsDays : 0;

  const quotationNumber = await allocateDocumentNumber(tx, context.organizationId, 'QUOTATION');

  const quotation = await tx.quotation.create({
    data: {
      organizationId: context.organizationId,
      quotationNumber,
      inquiryId: inquiry.id,
      customerId: inquiry.customerId,
      status: 'DRAFT',
      currency: organization.currency,
      paymentType,
      paymentTermsDays,
      validityDate: addDays(new Date(), validityDays),
      // Replaced by recalculate() before this function returns; a placeholder rather than a
      // nullable column, so the schema can require the hash to exist.
      currentPayloadHash: '',
      createdById: context.userId,
    },
  });

  let sortOrder = 0;
  for (const item of retained) {
    // Re-read the product through the tenant-scoped client. The id came from an inquiry row in
    // this organization, but re-resolving it here means a line can never be built from a
    // product this tenant cannot see, whatever put the id there.
    const product = await tx.product.findFirst({ where: { id: item.matchedProductId! } });
    if (!product) {
      return fail(
        'NOT_FOUND',
        `The product for line ${sortOrder + 1} is no longer in the catalogue.`,
      );
    }

    await tx.quotationItem.create({
      data: {
        organizationId: context.organizationId,
        quotationId: quotation.id,
        productId: product.id,
        // Snapshotted here and never read back through productId. This is what keeps the
        // quotation stable when the catalogue moves underneath it.
        skuSnapshot: product.sku,
        descriptionSnapshot: product.name,
        unitSnapshot: product.unit,
        quantity: item.requestedQuantity,
        listUnitPriceMinor: product.sellingPriceMinor,
        quotedUnitPriceMinor: product.sellingPriceMinor,
        discountBp: 0,
        taxRateBp: product.taxRateBp,
        lineSubtotalMinor: 0n,
        lineDiscountMinor: 0n,
        taxableAmountMinor: 0n,
        taxMinor: 0n,
        lineTotalMinor: 0n,
        sortOrder,
      },
    });
    sortOrder += 1;
  }

  const loaded = await load(tx, quotation.id);
  if (!loaded) return fail('INTERNAL', 'error.generic');
  const recalculated = await recalculate(tx, loaded);

  await recordAudit(tx, context, {
    action: 'quotation.created',
    entityType: 'quotation',
    entityId: quotation.id,
    newState: {
      quotationNumber,
      inquiryId: inquiry.id,
      customerId: inquiry.customerId,
      lineCount: retained.length,
      grandTotalMinor: recalculated.totals.grandTotalMinor.toString(),
      payloadHash: recalculated.payloadHash,
    },
  });

  return ok({ id: quotation.id, quotationNumber });
}

// ---------------------------------------------------------------------------
// The mutation envelope
// ---------------------------------------------------------------------------

/**
 * Wraps every commercial edit.
 *
 * Four things always happen together, and putting them in one place is what stops the fourth
 * from being forgotten:
 *
 *   1. the row is locked
 *   2. the change is applied
 *   3. every derived figure and the payload hash are recomputed from the stored rows
 *   4. if the quotation was approved or awaiting approval, that is withdrawn — the approval was
 *      given for figures that no longer exist
 */
async function mutate(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  action: string,
  apply: (loaded: LoadedQuotation) => Promise<Result<Record<string, unknown>>>,
): Promise<Result<null>> {
  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }

  const before = await load(tx, quotationId);
  if (!before) return fail('NOT_FOUND', 'error.notFound');

  if (!isEditable(before.quotation.status)) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `A ${before.quotation.status.toLowerCase().replace(/_/g, ' ')} quotation cannot be edited.`,
    );
  }

  const applied = await apply(before);
  if (!applied.ok) return applied;

  const reloaded = await load(tx, quotationId);
  if (!reloaded) return fail('INTERNAL', 'error.generic');
  const recalculated = await recalculate(tx, reloaded);

  const hashChanged = recalculated.payloadHash !== before.quotation.currentPayloadHash;
  const hadApproval = withdrawsApproval(before.quotation.status);

  await recordAudit(tx, context, {
    action,
    entityType: 'quotation',
    entityId: quotationId,
    oldState: {
      ...applied.value.oldState as Record<string, unknown>,
      payloadHash: before.quotation.currentPayloadHash,
    },
    newState: {
      ...applied.value.newState as Record<string, unknown>,
      payloadHash: recalculated.payloadHash,
      grandTotalMinor: recalculated.totals.grandTotalMinor.toString(),
    },
  });

  if (hadApproval && hashChanged) {
    await tx.quotation.update({
      where: { id: quotationId },
      data: {
        status: 'DRAFT',
        approvedById: null,
        approvedAt: null,
        approvedPayloadHash: null,
        submittedAt: null,
      },
    });

    await recordAudit(tx, context, {
      action: 'quotation.approval_invalidated',
      entityType: 'quotation',
      entityId: quotationId,
      oldState: {
        status: before.quotation.status,
        approvedPayloadHash: before.quotation.approvedPayloadHash,
        approvedById: before.quotation.approvedById,
      },
      newState: {
        status: 'DRAFT',
        reason: 'an approval-sensitive field changed',
        newPayloadHash: recalculated.payloadHash,
      },
      approvalStatus: 'INVALIDATED',
    });
  }

  return ok(null);
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export const lineQuantitySchema = z.object({ quantity: z.coerce.number().int().min(1).max(1_000_000) });
export const lineDiscountSchema = z.object({ discountBp: z.coerce.number().int().min(0).max(10_000) });
export const deliveryFeeSchema = z.object({ deliveryFee: z.string().trim() });
export const paymentTermsSchema = z.object({
  paymentType: z.enum(PAYMENT_TYPES),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(0),
});
export const addLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(1_000_000),
});

async function findLine(tx: TenantTransaction, quotationId: string, lineId: string) {
  return tx.quotationItem.findFirst({ where: { id: lineId, quotationId } });
}

export async function setLineQuantity(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  lineId: string,
  raw: unknown,
): Promise<Result<null>> {
  const parsed = lineQuantitySchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', 'Enter a whole quantity of at least one.');
  }

  return mutate(tx, context, quotationId, 'quotation.quantity_edited', async () => {
    const line = await findLine(tx, quotationId, lineId);
    if (!line) return fail('NOT_FOUND', 'error.notFound');

    await tx.quotationItem.update({
      where: { id: lineId },
      data: { quantity: parsed.data.quantity },
    });

    return ok({
      oldState: { line: line.skuSnapshot, quantity: line.quantity },
      newState: { line: line.skuSnapshot, quantity: parsed.data.quantity },
    });
  });
}

export async function setLineDiscount(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  lineId: string,
  raw: unknown,
): Promise<Result<null>> {
  const parsed = lineDiscountSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', 'A discount is between 0 and 10000 basis points.');
  }

  return mutate(tx, context, quotationId, 'quotation.discount_edited', async () => {
    const line = await findLine(tx, quotationId, lineId);
    if (!line) return fail('NOT_FOUND', 'error.notFound');

    await tx.quotationItem.update({
      where: { id: lineId },
      data: { discountBp: parsed.data.discountBp },
    });

    return ok({
      oldState: { line: line.skuSnapshot, discountBp: line.discountBp },
      newState: { line: line.skuSnapshot, discountBp: parsed.data.discountBp },
    });
  });
}

export async function removeLine(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  lineId: string,
): Promise<Result<null>> {
  return mutate(tx, context, quotationId, 'quotation.item_removed', async () => {
    const line = await findLine(tx, quotationId, lineId);
    if (!line) return fail('NOT_FOUND', 'error.notFound');

    const remaining = await tx.quotationItem.count({ where: { quotationId } });
    if (remaining <= 1) {
      return fail('VALIDATION_FAILED', 'A quotation must keep at least one line.');
    }

    await tx.quotationItem.delete({ where: { id: lineId } });

    return ok({
      oldState: { line: line.skuSnapshot, quantity: line.quantity },
      newState: { removed: true },
    });
  });
}

export async function addLine(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  raw: unknown,
): Promise<Result<null>> {
  const parsed = addLineSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', 'Choose a product and a whole quantity of at least one.');
  }

  return mutate(tx, context, quotationId, 'quotation.item_added', async () => {
    // Scoped read: a product id from another organization is not found, so a crafted form post
    // cannot price a foreign product into this quotation.
    const product = await tx.product.findFirst({
      where: { id: parsed.data.productId, active: true },
    });
    if (!product) return fail('NOT_FOUND', 'That product is not in this catalogue.');

    const highest = await tx.quotationItem.aggregate({
      where: { quotationId },
      _max: { sortOrder: true },
    });

    await tx.quotationItem.create({
      data: {
        organizationId: context.organizationId,
        quotationId,
        productId: product.id,
        skuSnapshot: product.sku,
        descriptionSnapshot: product.name,
        unitSnapshot: product.unit,
        quantity: parsed.data.quantity,
        listUnitPriceMinor: product.sellingPriceMinor,
        quotedUnitPriceMinor: product.sellingPriceMinor,
        discountBp: 0,
        taxRateBp: product.taxRateBp,
        lineSubtotalMinor: 0n,
        lineDiscountMinor: 0n,
        taxableAmountMinor: 0n,
        taxMinor: 0n,
        lineTotalMinor: 0n,
        sortOrder: (highest._max.sortOrder ?? -1) + 1,
      },
    });

    return ok({
      oldState: {},
      newState: { sku: product.sku, quantity: parsed.data.quantity },
    });
  });
}

export async function setDeliveryFee(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  deliveryFeeMinor: bigint,
): Promise<Result<null>> {
  if (deliveryFeeMinor < 0n) {
    return fail('VALIDATION_FAILED', 'A delivery fee cannot be negative.');
  }

  return mutate(tx, context, quotationId, 'quotation.delivery_fee_edited', async (loaded) => {
    await tx.quotation.update({ where: { id: quotationId }, data: { deliveryFeeMinor } });
    return ok({
      oldState: { deliveryFeeMinor: loaded.quotation.deliveryFeeMinor.toString() },
      newState: { deliveryFeeMinor: deliveryFeeMinor.toString() },
    });
  });
}

export async function setPaymentTerms(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  raw: unknown,
): Promise<Result<null>> {
  const parsed = paymentTermsSchema.safeParse(raw);
  if (!parsed.success) return fail('VALIDATION_FAILED', 'Choose valid payment terms.');

  const paymentTermsDays = parsed.data.paymentType === 'CASH' ? 0 : parsed.data.paymentTermsDays;
  if (parsed.data.paymentType === 'CREDIT' && !CREDIT_TERM_DAYS.includes(paymentTermsDays as 7)) {
    return fail('VALIDATION_FAILED', 'Credit terms must be 7, 15 or 30 days.');
  }

  return mutate(tx, context, quotationId, 'quotation.payment_terms_changed', async (loaded) => {
    await tx.quotation.update({
      where: { id: quotationId },
      data: { paymentType: parsed.data.paymentType, paymentTermsDays },
    });
    return ok({
      oldState: {
        paymentType: loaded.quotation.paymentType,
        paymentTermsDays: loaded.quotation.paymentTermsDays,
      },
      newState: { paymentType: parsed.data.paymentType, paymentTermsDays },
    });
  });
}

/**
 * Moves the quotation to a different customer.
 *
 * Credit terms are dropped rather than carried across. The new customer has not been granted
 * the old one's terms, and quietly keeping them would be the system extending credit nobody
 * authorised.
 */
export async function setCustomer(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  customerId: string,
): Promise<Result<null>> {
  return mutate(tx, context, quotationId, 'quotation.customer_changed', async (loaded) => {
    const customer = await tx.customer.findFirst({ where: { id: customerId } });
    if (!customer) return fail('NOT_FOUND', 'That customer is not in this organization.');

    const keepsCredit =
      loaded.quotation.paymentType === 'CREDIT' && customer.creditStatus === 'CREDIT_ALLOWED';

    await tx.quotation.update({
      where: { id: quotationId },
      data: {
        customerId,
        paymentType: keepsCredit ? 'CREDIT' : 'CASH',
        paymentTermsDays: keepsCredit
          ? Math.min(loaded.quotation.paymentTermsDays, customer.paymentTermsDays || 0)
          : 0,
      },
    });

    return ok({
      oldState: {
        customerId: loaded.quotation.customerId,
        creditStatus: loaded.customer.creditStatus,
        paymentType: loaded.quotation.paymentType,
      },
      newState: {
        customerId,
        creditStatus: customer.creditStatus,
        paymentType: keepsCredit ? 'CREDIT' : 'CASH',
        creditTermsDropped: loaded.quotation.paymentType === 'CREDIT' && !keepsCredit,
      },
    });
  });
}

export async function setValidityDate(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  validityDate: Date,
): Promise<Result<null>> {
  return mutate(tx, context, quotationId, 'quotation.validity_changed', async (loaded) => {
    await tx.quotation.update({ where: { id: quotationId }, data: { validityDate } });
    return ok({
      oldState: { validityDate: loaded.quotation.validityDate.toISOString().slice(0, 10) },
      newState: { validityDate: validityDate.toISOString().slice(0, 10) },
    });
  });
}

/**
 * Notes are deliberately outside the mutation envelope.
 *
 * They change what the customer reads, not what the organization is committing to, so they are
 * not in the approval payload and editing one does not revoke an approval. Treating a typo fix
 * as grounds for re-approval is how a control like this stops being taken seriously.
 */
export async function setNotes(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  notes: { customerNotes?: string | null; internalNotes?: string | null },
): Promise<Result<null>> {
  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  const loaded = await load(tx, quotationId);
  if (!loaded) return fail('NOT_FOUND', 'error.notFound');
  if (loaded.quotation.status === 'SENT' || !isEditable(loaded.quotation.status)) {
    return fail('INVALID_STATE_TRANSITION', 'This quotation can no longer be edited.');
  }

  await tx.quotation.update({ where: { id: quotationId }, data: notes });
  await recordAudit(tx, context, {
    action: 'quotation.notes_edited',
    entityType: 'quotation',
    entityId: quotationId,
    newState: { changed: Object.keys(notes) },
  });
  return ok(null);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

async function transition(
  tx: TenantTransaction,
  quotationId: string,
  from: QuotationStatus,
  to: QuotationStatus,
  extra: Record<string, unknown> = {},
): Promise<Result<null>> {
  if (!canTransition(from, to)) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `A quotation cannot go from ${from.toLowerCase().replace(/_/g, ' ')} to ${to
        .toLowerCase()
        .replace(/_/g, ' ')}.`,
    );
  }
  await tx.quotation.update({ where: { id: quotationId }, data: { status: to, ...extra } });
  return ok(null);
}

export async function submitForApproval(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
): Promise<Result<ApprovalRequirement>> {
  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  const loaded = await load(tx, quotationId);
  if (!loaded) return fail('NOT_FOUND', 'error.notFound');

  const recalculated = await recalculate(tx, loaded);

  if (recalculated.requirement.blocked) {
    return fail(
      'VALIDATION_FAILED',
      recalculated.requirement.reasons.find((reason) => reason.code !== 'DISCOUNT_WITHIN_SALESPERSON_LIMIT')
        ?.message ?? 'This quotation cannot be approved as it stands.',
    );
  }

  const moved = await transition(tx, quotationId, loaded.quotation.status, 'PENDING_APPROVAL', {
    submittedAt: new Date(),
  });
  if (!moved.ok) return moved;

  await recordAudit(tx, context, {
    action: 'quotation.submitted',
    entityType: 'quotation',
    entityId: quotationId,
    newState: {
      requiredLevel: recalculated.requirement.level,
      payloadHash: recalculated.payloadHash,
      grandTotalMinor: recalculated.totals.grandTotalMinor.toString(),
    },
    approvalStatus: 'PENDING',
  });

  return ok(recalculated.requirement);
}

export interface ApproveOptions {
  /** The hash the approver was shown. Refused if the figures have moved since. */
  readonly expectedPayloadHash?: string;
  readonly reason?: string;
}

/**
 * Grants approval, binding it to the exact figures.
 *
 * The hash is re-derived from the persisted rows inside the lock rather than taken from the
 * caller, so an edit that committed between the screen being rendered and the button being
 * pressed is seen. When the caller supplies `expectedPayloadHash`, a mismatch is refused
 * outright — the approver is told the figures changed rather than silently approving different
 * ones.
 */
export async function approve(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  options: ApproveOptions = {},
): Promise<Result<{ payloadHash: string; alreadyApproved: boolean }>> {
  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  const loaded = await load(tx, quotationId);
  if (!loaded) return fail('NOT_FOUND', 'error.notFound');

  const recalculated = await recalculate(tx, loaded);

  // Idempotent: approving twice with the same figures is a double click, not a second decision.
  if (
    loaded.quotation.status === 'APPROVED' &&
    loaded.quotation.approvedPayloadHash === recalculated.payloadHash
  ) {
    return ok({ payloadHash: recalculated.payloadHash, alreadyApproved: true });
  }

  if (loaded.quotation.status !== 'PENDING_APPROVAL') {
    return fail(
      'INVALID_STATE_TRANSITION',
      `Only a quotation awaiting approval can be approved; this one is ${loaded.quotation.status
        .toLowerCase()
        .replace(/_/g, ' ')}.`,
    );
  }

  if (options.expectedPayloadHash && options.expectedPayloadHash !== recalculated.payloadHash) {
    return fail(
      'APPROVAL_PAYLOAD_MISMATCH',
      'The figures changed while you were reviewing. Reload and check them again before approving.',
    );
  }

  if (recalculated.requirement.blocked) {
    return fail(
      'VALIDATION_FAILED',
      recalculated.requirement.reasons.find((reason) => reason.code !== 'DISCOUNT_WITHIN_SALESPERSON_LIMIT')
        ?.message ?? 'This quotation cannot be approved as it stands.',
    );
  }

  const role = context.role;
  if (!role || !rolesSatisfying(recalculated.requirement.level).includes(role)) {
    return fail(
      'APPROVAL_REQUIRED',
      recalculated.requirement.level === 'SALES_MANAGER'
        ? 'This quotation needs a sales manager to approve it.'
        : 'Your role cannot approve this quotation.',
    );
  }

  await tx.quotationApproval.create({
    data: {
      organizationId: context.organizationId,
      quotationId,
      approverId: context.userId!,
      approverRole: role,
      requiredLevel: recalculated.requirement.level,
      payloadHash: recalculated.payloadHash,
      decision: 'APPROVED',
      reason: options.reason ?? null,
    },
  });

  const moved = await transition(tx, quotationId, 'PENDING_APPROVAL', 'APPROVED', {
    approvedById: context.userId,
    approvedAt: new Date(),
    approvedPayloadHash: recalculated.payloadHash,
  });
  if (!moved.ok) return moved;

  await recordAudit(tx, context, {
    action: 'quotation.approved',
    entityType: 'quotation',
    entityId: quotationId,
    newState: {
      requiredLevel: recalculated.requirement.level,
      approverRole: role,
      payloadHash: recalculated.payloadHash,
      grandTotalMinor: recalculated.totals.grandTotalMinor.toString(),
    },
    approvalStatus: 'APPROVED',
  });

  return ok({ payloadHash: recalculated.payloadHash, alreadyApproved: false });
}

export async function reject(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  reason: string,
): Promise<Result<null>> {
  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  const loaded = await load(tx, quotationId);
  if (!loaded) return fail('NOT_FOUND', 'error.notFound');
  if (loaded.quotation.status !== 'PENDING_APPROVAL') {
    return fail('INVALID_STATE_TRANSITION', 'Only a quotation awaiting approval can be rejected.');
  }
  if (!reason.trim()) {
    return fail('VALIDATION_FAILED', 'Say why it is being rejected.');
  }

  const recalculated = await recalculate(tx, loaded);
  const role = context.role;

  // Whoever could have approved it can refuse it. Anyone else has no standing to reject a
  // colleague's quotation.
  if (!role || !rolesSatisfying(recalculated.requirement.level).includes(role)) {
    return fail('FORBIDDEN', 'error.forbidden');
  }

  await tx.quotationApproval.create({
    data: {
      organizationId: context.organizationId,
      quotationId,
      approverId: context.userId!,
      approverRole: role,
      requiredLevel: recalculated.requirement.level,
      payloadHash: recalculated.payloadHash,
      decision: 'REJECTED',
      reason: reason.trim(),
    },
  });

  // Back to draft rather than to a REJECTED terminal state: an internal rejection is feedback
  // to the salesperson, not the end of the quotation.
  const moved = await transition(tx, quotationId, 'PENDING_APPROVAL', 'DRAFT', {
    submittedAt: null,
  });
  if (!moved.ok) return moved;

  await recordAudit(tx, context, {
    action: 'quotation.approval_rejected',
    entityType: 'quotation',
    entityId: quotationId,
    newState: { reason: reason.trim(), payloadHash: recalculated.payloadHash },
    approvalStatus: 'REJECTED',
  });

  return ok(null);
}

/**
 * Records that the quotation was sent to the customer.
 *
 * Nothing leaves the building. Phase 3 has no messaging integration; this marks the fact that a
 * person sent it by whatever means they use today.
 *
 * The approval check here re-derives the hash rather than trusting the stored status, which is
 * the invariant that survives a race: if an edit committed between approval and this call, the
 * recomputed hash no longer matches what was approved and the send is refused — even if the
 * edit path had somehow failed to withdraw the approval.
 */
export async function markSent(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
): Promise<Result<null>> {
  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  const loaded = await load(tx, quotationId);
  if (!loaded) return fail('NOT_FOUND', 'error.notFound');

  const recalculated = await recalculate(tx, loaded);

  if (loaded.quotation.status !== 'APPROVED') {
    return fail(
      'APPROVAL_REQUIRED',
      'A quotation must be approved before it can be sent.',
    );
  }
  if (loaded.quotation.approvedPayloadHash !== recalculated.payloadHash) {
    return fail(
      'APPROVAL_PAYLOAD_MISMATCH',
      'These figures are not the ones that were approved. The quotation must be approved again.',
    );
  }

  const sentAt = new Date();
  const moved = await transition(tx, quotationId, 'APPROVED', 'SENT', {
    sentAt,
    sentById: context.userId,
  });
  if (!moved.ok) return moved;

  // The first chase is scheduled in the same transaction as the send. A quotation cannot be
  // recorded as sent without appearing in the follow-up queue, which is precisely the failure
  // the queue exists to prevent.
  const scheduled = await scheduleFirstFollowUp(tx, context, {
    quotationId,
    sentAt,
    intervalDays: loaded.policy.followUpIntervalDays,
    assignedUserId: context.userId,
  });
  if (!scheduled.ok) return scheduled;

  await recordAudit(tx, context, {
    action: 'quotation.marked_sent',
    entityType: 'quotation',
    entityId: quotationId,
    newState: {
      payloadHash: recalculated.payloadHash,
      grandTotalMinor: recalculated.totals.grandTotalMinor.toString(),
      // Explicit: no integration sent anything. A person did, by hand, elsewhere.
      delivery: 'recorded_manually',
    },
    approvalStatus: 'APPROVED',
  });

  return ok(null);
}

export async function cancelQuotation(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  reason: string,
): Promise<Result<null>> {
  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  const loaded = await load(tx, quotationId);
  if (!loaded) return fail('NOT_FOUND', 'error.notFound');

  const moved = await transition(tx, quotationId, loaded.quotation.status, 'CANCELLED');
  if (!moved.ok) return moved;

  await recordAudit(tx, context, {
    action: 'quotation.cancelled',
    entityType: 'quotation',
    entityId: quotationId,
    oldState: { status: loaded.quotation.status },
    newState: { status: 'CANCELLED', reason: reason.trim() || null },
  });

  return ok(null);
}

// ---------------------------------------------------------------------------
// Phase 4 — what the customer said
// ---------------------------------------------------------------------------

export const ACCEPTANCE_SOURCES = ['PHONE', 'MESSAGE', 'EMAIL', 'IN_PERSON', 'OTHER'] as const;
export type AcceptanceSource = (typeof ACCEPTANCE_SOURCES)[number];

export const REJECTION_REASONS = [
  'PRICE',
  'STOCK',
  'DELIVERY',
  'TIMING',
  'COMPETITOR',
  'CUSTOMER_CANCELLED',
  'OTHER',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const acceptanceSchema = z.object({
  source: z.enum(ACCEPTANCE_SOURCES),
  note: z.string().trim().max(1000).optional().or(z.literal('')),
});

export const rejectionSchema = z.object({
  reason: z.enum(REJECTION_REASONS).optional(),
  note: z.string().trim().max(1000).optional().or(z.literal('')),
});

/** Whether a quotation is past its validity date, compared as calendar dates in UTC. */
export function isExpired(validityDate: Date, now: Date = new Date()): boolean {
  const validUntil = new Date(
    Date.UTC(validityDate.getUTCFullYear(), validityDate.getUTCMonth(), validityDate.getUTCDate()),
  );
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return today > validUntil;
}

export interface AcceptanceEligibility {
  readonly eligible: boolean;
  readonly reason: string | null;
}

/**
 * Whether a quotation may be recorded as accepted.
 *
 * A pure function so the rule can be enumerated in a unit test rather than inferred from the
 * database path. The conditions are the ones that make an acceptance meaningful: the customer
 * must have been sent something, that something must still be what was approved, and it must
 * still be on offer.
 */
export function acceptanceEligibility(input: {
  status: QuotationStatus;
  approvalIsLive: boolean;
  validityDate: Date;
  now?: Date;
}): AcceptanceEligibility {
  if (input.status !== 'SENT') {
    return {
      eligible: false,
      reason:
        `Only a quotation that has been sent can be accepted; this one is ${input.status
          .toLowerCase()
          .replace(/_/g, ' ')}.`,
    };
  }

  if (!input.approvalIsLive) {
    // Reaching SENT requires a live approval, so this means something changed underneath
    // afterwards. Recording an acceptance against figures nobody approved would be worse than
    // refusing, however inconvenient the refusal is.
    return {
      eligible: false,
      reason:
        'The figures on this quotation no longer match what was approved, so an acceptance cannot be recorded against them.',
    };
  }

  if (isExpired(input.validityDate, input.now)) {
    return {
      eligible: false,
      reason:
        'This quotation has passed its validity date. Prices may have moved, so raise a new quotation rather than accepting this one.',
    };
  }

  return { eligible: true, reason: null };
}

/**
 * Records that a customer accepted.
 *
 * This is staff reporting what they were told. It is not an electronic signature, nothing here
 * authenticates the customer, and the UI says so — presenting it as more than it is would be the
 * kind of quiet overclaim that makes an audit trail worthless when it matters.
 */
export async function recordAcceptance(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  raw: unknown,
): Promise<Result<{ acceptedAt: Date; closedFollowUps: number }>> {
  const parsed = acceptanceSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', 'Say how the customer told you they accepted.');
  }

  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  const loaded = await load(tx, quotationId);
  if (!loaded) return fail('NOT_FOUND', 'error.notFound');

  // Re-derived inside the lock, not trusted from an earlier read.
  const recalculated = await recalculate(tx, loaded);
  const approvalIsLive =
    loaded.quotation.approvedPayloadHash !== null &&
    loaded.quotation.approvedPayloadHash === recalculated.payloadHash;

  const eligibility = acceptanceEligibility({
    status: loaded.quotation.status,
    approvalIsLive,
    validityDate: loaded.quotation.validityDate,
  });
  if (!eligibility.eligible) {
    return fail('INVALID_STATE_TRANSITION', eligibility.reason ?? 'error.generic');
  }

  const acceptedAt = new Date();
  const moved = await transition(tx, quotationId, 'SENT', 'ACCEPTED', {
    acceptedAt,
    acceptedById: context.userId,
    acceptanceSource: parsed.data.source,
    acceptanceNote: parsed.data.note?.trim() || null,
  });
  if (!moved.ok) return moved;

  // Nobody should be asked to chase a quotation the customer has already answered.
  const closedFollowUps = await cancelOpenFollowUps(
    tx,
    context,
    quotationId,
    'the customer accepted the quotation',
  );

  await recordAudit(tx, context, {
    action: 'quotation.accepted',
    entityType: 'quotation',
    entityId: quotationId,
    newState: {
      source: parsed.data.source,
      payloadHash: recalculated.payloadHash,
      grandTotalMinor: recalculated.totals.grandTotalMinor.toString(),
      closedFollowUps,
      // Explicit, so nobody reading the log later mistakes this for a signature.
      basis: 'recorded_by_staff',
    },
  });

  return ok({ acceptedAt, closedFollowUps });
}

export async function recordRejection(
  tx: TenantTransaction,
  context: ActorContext,
  quotationId: string,
  raw: unknown,
): Promise<Result<{ rejectedAt: Date; closedFollowUps: number }>> {
  const parsed = rejectionSchema.safeParse(raw);
  if (!parsed.success) return fail('VALIDATION_FAILED', 'error.generic');

  if (!(await lockQuotation(tx, context.organizationId, quotationId))) {
    return fail('NOT_FOUND', 'error.notFound');
  }
  const loaded = await load(tx, quotationId);
  if (!loaded) return fail('NOT_FOUND', 'error.notFound');

  if (loaded.quotation.status !== 'SENT') {
    return fail(
      'INVALID_STATE_TRANSITION',
      `Only a quotation that has been sent can be rejected; this one is ${loaded.quotation.status
        .toLowerCase()
        .replace(/_/g, ' ')}.`,
    );
  }

  const rejectedAt = new Date();
  const moved = await transition(tx, quotationId, 'SENT', 'REJECTED', {
    rejectedAt,
    rejectedById: context.userId,
    // Optional on purpose. Forcing a category produces a category, not a reason.
    rejectionReason: parsed.data.reason ?? null,
    rejectionNote: parsed.data.note?.trim() || null,
  });
  if (!moved.ok) return moved;

  const closedFollowUps = await cancelOpenFollowUps(
    tx,
    context,
    quotationId,
    'the customer rejected the quotation',
  );

  await recordAudit(tx, context, {
    action: 'quotation.rejected',
    entityType: 'quotation',
    entityId: quotationId,
    newState: {
      reason: parsed.data.reason ?? null,
      closedFollowUps,
      basis: 'recorded_by_staff',
    },
  });

  return ok({ rejectedAt, closedFollowUps });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface QuotationLineView {
  readonly id: string;
  readonly sku: string;
  readonly description: string;
  readonly unit: string;
  readonly quantity: number;
  readonly listUnitPriceMinor: bigint;
  readonly quotedUnitPriceMinor: bigint;
  readonly effectiveUnitPriceMinor: bigint;
  readonly discountBp: number;
  readonly taxRateBp: number;
  readonly lineSubtotalMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly taxMinor: bigint;
  readonly lineTotalMinor: bigint;
  /** Live catalogue context, shown beside the snapshot. Never used in arithmetic. */
  readonly currentStock: number | null;
  readonly currentListPriceMinor: bigint | null;
  readonly priceHasMoved: boolean;
}

export interface QuotationView {
  readonly id: string;
  readonly quotationNumber: string;
  readonly status: QuotationStatus;
  readonly currency: string;
  readonly customer: { id: string; companyName: string; creditStatus: string };
  readonly inquiryId: string | null;
  readonly paymentType: PaymentType;
  readonly paymentTermsDays: number;
  readonly validityDate: Date;
  readonly customerNotes: string | null;
  readonly internalNotes: string | null;
  readonly lines: readonly QuotationLineView[];
  readonly subtotalMinor: bigint;
  readonly discountTotalMinor: bigint;
  readonly deliveryFeeMinor: bigint;
  readonly deliveryTaxMinor: bigint;
  readonly taxTotalMinor: bigint;
  readonly grandTotalMinor: bigint;
  readonly deliveryFeeTaxable: boolean;
  readonly requirement: ApprovalRequirement;
  readonly currentPayloadHash: string;
  readonly approvedPayloadHash: string | null;
  /** True only when the approval on file is for the figures currently stored. */
  readonly approvalIsLive: boolean;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly approvals: readonly {
    id: string;
    decision: string;
    approverRole: string;
    requiredLevel: string;
    payloadHash: string;
    reason: string | null;
    createdAt: Date;
    matchesCurrent: boolean;
  }[];
}

export async function getQuotation(
  tx: TenantTransaction,
  quotationId: string,
): Promise<Result<QuotationView>> {
  const quotation = await tx.quotation.findFirst({
    where: { id: quotationId },
    include: {
      customer: true,
      items: { orderBy: { sortOrder: 'asc' }, include: { product: true } },
      approvals: { orderBy: { createdAt: 'desc' } },
      organization: { include: { settings: true } },
    },
  });
  if (!quotation) return fail('NOT_FOUND', 'error.notFound');

  const policy = {
    salespersonDiscountLimitBp:
      quotation.organization.settings?.salespersonDiscountLimitBp ??
      DEFAULT_POLICY.salespersonDiscountLimitBp,
    salesManagerDiscountLimitBp:
      quotation.organization.settings?.salesManagerDiscountLimitBp ??
      DEFAULT_POLICY.salesManagerDiscountLimitBp,
    minimumPriceFloorBp:
      quotation.organization.settings?.minimumPriceFloorBp ?? DEFAULT_POLICY.minimumPriceFloorBp,
  };

  const lineInputs: PricedLineInput[] = quotation.items.map((item) => ({
    quantity: item.quantity,
    listUnitPriceMinor: item.listUnitPriceMinor,
    quotedUnitPriceMinor: item.quotedUnitPriceMinor,
    discountBp: item.discountBp,
    taxRateBp: item.taxRateBp,
  }));

  const requirement = evaluateApproval({
    lines: lineInputs,
    paymentType: quotation.paymentType as PaymentType,
    paymentTermsDays: quotation.paymentTermsDays,
    customerCreditStatus: quotation.customer.creditStatus as 'CASH_ONLY',
    customerPaymentTermsDays: quotation.customer.paymentTermsDays,
    policy,
  });

  const lines: QuotationLineView[] = quotation.items.map((item) => {
    // Display only, and derived the same way the pricing module derives it, so the two never
    // disagree. Never multiplied back: the line total is authoritative, this is a courtesy.
    const effective = effectiveUnitPrice(
      item.quotedUnitPriceMinor,
      item.discountBp,
      quotation.currency,
    );
    return {
      id: item.id,
      sku: item.skuSnapshot,
      description: item.descriptionSnapshot,
      unit: item.unitSnapshot,
      quantity: item.quantity,
      listUnitPriceMinor: item.listUnitPriceMinor,
      quotedUnitPriceMinor: item.quotedUnitPriceMinor,
      effectiveUnitPriceMinor: effective,
      discountBp: item.discountBp,
      taxRateBp: item.taxRateBp,
      lineSubtotalMinor: item.lineSubtotalMinor,
      lineDiscountMinor: item.lineDiscountMinor,
      taxMinor: item.taxMinor,
      lineTotalMinor: item.lineTotalMinor,
      // Live context only. The quotation's own figures are the snapshots above.
      currentStock: item.product ? freeStock(item.product) : null,
      currentListPriceMinor: item.product?.sellingPriceMinor ?? null,
      priceHasMoved: item.product
        ? item.product.sellingPriceMinor !== item.listUnitPriceMinor
        : false,
    };
  });

  const approvalIsLive =
    quotation.status === 'APPROVED' &&
    quotation.approvedPayloadHash !== null &&
    quotation.approvedPayloadHash === quotation.currentPayloadHash;

  return ok({
    id: quotation.id,
    quotationNumber: quotation.quotationNumber,
    status: quotation.status as QuotationStatus,
    currency: quotation.currency,
    customer: {
      id: quotation.customer.id,
      companyName: quotation.customer.companyName,
      creditStatus: quotation.customer.creditStatus,
    },
    inquiryId: quotation.inquiryId,
    paymentType: quotation.paymentType as PaymentType,
    paymentTermsDays: quotation.paymentTermsDays,
    validityDate: quotation.validityDate,
    customerNotes: quotation.customerNotes,
    internalNotes: quotation.internalNotes,
    lines,
    subtotalMinor: quotation.subtotalMinor,
    discountTotalMinor: quotation.discountTotalMinor,
    deliveryFeeMinor: quotation.deliveryFeeMinor,
    deliveryTaxMinor: quotation.deliveryTaxMinor,
    taxTotalMinor: quotation.taxTotalMinor,
    grandTotalMinor: quotation.grandTotalMinor,
    deliveryFeeTaxable:
      quotation.organization.settings?.deliveryFeeTaxable ?? DEFAULT_POLICY.deliveryFeeTaxable,
    requirement,
    currentPayloadHash: quotation.currentPayloadHash,
    approvedPayloadHash: quotation.approvedPayloadHash,
    approvalIsLive,
    approvedBy: quotation.approvedById,
    approvedAt: quotation.approvedAt,
    sentAt: quotation.sentAt,
    createdAt: quotation.createdAt,
    approvals: quotation.approvals.map((approval) => ({
      id: approval.id,
      decision: approval.decision,
      approverRole: approval.approverRole,
      requiredLevel: approval.requiredLevel,
      payloadHash: approval.payloadHash,
      reason: approval.reason,
      createdAt: approval.createdAt,
      matchesCurrent: approval.payloadHash === quotation.currentPayloadHash,
    })),
  });
}

export interface QuotationListRow {
  readonly id: string;
  readonly quotationNumber: string;
  readonly status: QuotationStatus;
  readonly customerName: string;
  readonly grandTotalMinor: bigint;
  readonly currency: string;
  readonly requiredLevel: ApprovalLevel;
  readonly validityDate: Date;
  readonly createdAt: Date;
  readonly approvalIsLive: boolean;
}

export async function listQuotations(
  tx: TenantTransaction,
  options: { status?: QuotationStatus } = {},
): Promise<QuotationListRow[]> {
  const rows = await tx.quotation.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { customer: { select: { companyName: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    quotationNumber: row.quotationNumber,
    status: row.status as QuotationStatus,
    customerName: row.customer.companyName,
    grandTotalMinor: row.grandTotalMinor,
    currency: row.currency,
    requiredLevel: row.requiredLevel as ApprovalLevel,
    validityDate: row.validityDate,
    createdAt: row.createdAt,
    approvalIsLive:
      row.status === 'APPROVED' &&
      row.approvedPayloadHash !== null &&
      row.approvedPayloadHash === row.currentPayloadHash,
  }));
}

/** Which roles may satisfy the level this quotation requires. Used by the UI to explain itself. */
export function canRoleApprove(role: Role, level: ApprovalLevel): boolean {
  return rolesSatisfying(level).includes(role);
}
