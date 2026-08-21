import 'server-only';
import { z } from 'zod';
import { type TenantTransaction, withTenant } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { type Result, fail, ok } from '@/platform/result';
import { hashString } from '@/platform/security';
import { aiProvider } from '@/platform/ai';
import type { AIProvider } from '@/platform/ai';
import {
  type ConfidenceBand,
  type MatchCandidate,
  type UnitCheck,
  checkUnit,
  confidenceBand,
  freeStock,
  loadMatchCorpus,
  matchProduct,
  normalizeUnit,
  validateQuantity,
} from '@/modules/catalog';
import { recordAudit } from '@/modules/audit';
import { type InquiryStatus, canTransition } from './state';
import { type ReadinessItem, type ReadinessVerdict, evaluateReadiness } from './readiness';

export * from './state';
export * from './readiness';

export const INQUIRY_CHANNELS = [
  'MANUAL',
  'WHATSAPP',
  'TELEGRAM',
  'EMAIL',
  'SMS',
  'PHONE_NOTE',
] as const;

export type InquiryChannel = (typeof INQUIRY_CHANNELS)[number];

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export const inquiryInputSchema = z.object({
  /**
   * The customer's message. Stored verbatim and never rewritten — it is the evidence every
   * later interpretation is checked against.
   */
  rawMessage: z.string().trim().min(1, 'error.required').max(8000),
  /**
   * Only MANUAL is wired end to end in Phase 2. The others exist so that a channel adapter can
   * be added later without a migration; nothing connects to an external provider.
   */
  channel: z.enum(INQUIRY_CHANNELS).default('MANUAL'),
  customerId: z.string().uuid().nullable().optional().or(z.literal('')),
});

/** Collapses whitespace for display and fingerprinting. Not a translation, not a rewrite. */
export function normalizeMessage(raw: string): string {
  return raw.normalize('NFC').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

export async function createInquiry(
  tx: TenantTransaction,
  context: ActorContext,
  raw: unknown,
): Promise<Result<{ id: string }>> {
  const parsed = inquiryInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'error.generic', {
      field: parsed.error.issues[0]?.path.join('.'),
    });
  }
  const input = parsed.data;
  const customerId = input.customerId ? input.customerId : null;

  if (customerId) {
    // Scoped read: a customer id from another organization simply is not found.
    const customer = await tx.customer.findFirst({ where: { id: customerId } });
    if (!customer) return fail('NOT_FOUND', 'error.notFound', { field: 'customerId' });
  }

  const created = await tx.inquiry.create({
    data: {
      organizationId: context.organizationId,
      customerId,
      channel: input.channel,
      rawMessage: input.rawMessage,
      normalizedText: normalizeMessage(input.rawMessage),
      status: 'RECEIVED',
      createdById: context.userId,
      assignedUserId: context.userId,
    },
  });

  await recordAudit(tx, context, {
    action: 'inquiry.created',
    entityType: 'inquiry',
    entityId: created.id,
    newState: {
      channel: created.channel,
      customerId,
      // A fingerprint rather than the text: the message is already stored once on the row, and
      // the audit log is exported and retained far more widely than the inquiry table.
      messageFingerprint: hashString(created.normalizedText).slice(0, 12),
      messageLength: created.rawMessage.length,
    },
  });

  return ok({ id: created.id });
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

async function transition(
  tx: TenantTransaction,
  context: ActorContext,
  inquiryId: string,
  from: InquiryStatus,
  to: InquiryStatus,
  extra: Record<string, unknown> = {},
): Promise<Result<null>> {
  if (!canTransition(from, to)) {
    return fail(
      'INVALID_STATE_TRANSITION',
      `An inquiry cannot go from ${from.toLowerCase()} to ${to.toLowerCase()}.`,
    );
  }

  await tx.inquiry.update({ where: { id: inquiryId }, data: { status: to, ...extra } });
  await recordAudit(tx, context, {
    action: `inquiry.${to.toLowerCase()}`,
    entityType: 'inquiry',
    entityId: inquiryId,
    oldState: { status: from },
    newState: { status: to },
  });
  return ok(null);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Runs the parse pipeline for one inquiry.
 *
 * This function manages its own transactions rather than joining a caller's, because the
 * provider call in the middle can take seconds and must not hold a database connection open
 * while it waits. The sequence is:
 *
 *   1. transaction: move to PARSING, so a second click cannot start a concurrent parse
 *   2. no transaction: ask the provider, validate its answer against the Zod contract
 *   3. transaction: match deterministically, write proposals, record the AI call, move on
 *
 * Step 2 produces a *proposal*. Step 3 is where the catalogue, the prices and the stock come
 * from — all read from this organization's rows, none of them from the model.
 */
export async function runParse(
  organizationId: string,
  context: ActorContext,
  inquiryId: string,
  provider: AIProvider = aiProvider(),
): Promise<Result<{ status: InquiryStatus; itemCount: number }>> {
  const started = await withTenant(organizationId, async (tx) => {
    const inquiry = await tx.inquiry.findFirst({ where: { id: inquiryId } });
    if (!inquiry) return fail<{ text: string; from: InquiryStatus }>('NOT_FOUND', 'error.notFound');

    const from = inquiry.status as InquiryStatus;
    if (!canTransition(from, 'PARSING')) {
      return fail<{ text: string; from: InquiryStatus }>(
        'INVALID_STATE_TRANSITION',
        `This inquiry is ${from.toLowerCase().replace(/_/g, ' ')} and cannot be parsed now.`,
      );
    }

    const moved = await transition(tx, context, inquiryId, from, 'PARSING', { parseError: null });
    if (!moved.ok) return moved;

    await recordAudit(tx, context, {
      action: 'inquiry.parse_started',
      entityType: 'inquiry',
      entityId: inquiryId,
      newState: { provider: provider.name },
      aiInvolved: true,
    });

    return ok({ text: inquiry.rawMessage, from });
  });

  if (!started.ok) return started;

  // --- outside any transaction: the untrusted text meets the model -----------
  const outcome = await provider.parseInquiry({ text: started.value.text });
  const fingerprint = hashString(started.value.text);

  if (!outcome.ok) {
    return withTenant(organizationId, async (tx) => {
      await tx.aiInteraction.create({
        data: {
          organizationId: context.organizationId,
          inquiryId,
          purpose: 'parse_inquiry',
          provider: outcome.meta.provider,
          model: outcome.meta.model,
          promptVersion: outcome.meta.promptVersion,
          inputFingerprint: fingerprint,
          valid: false,
          errorCode: outcome.errorCode,
          latencyMs: outcome.meta.latencyMs,
        },
      });

      const moved = await transition(tx, context, inquiryId, 'PARSING', 'PARSE_FAILED', {
        parseError: `${outcome.errorCode}: ${outcome.message}`.slice(0, 500),
      });
      if (!moved.ok) return moved;

      await recordAudit(tx, context, {
        action: 'inquiry.parse_failed',
        entityType: 'inquiry',
        entityId: inquiryId,
        newState: { errorCode: outcome.errorCode, provider: outcome.meta.provider },
        aiInvolved: true,
      });

      // A failure, not a partial success. Nothing was written to the item table, the customer's
      // message is untouched, and the inquiry can be parsed again.
      return fail<{ status: InquiryStatus; itemCount: number }>(
        outcome.errorCode === 'SCHEMA_INVALID' ? 'AI_OUTPUT_INVALID' : 'PROVIDER_ERROR',
        outcome.errorCode === 'SCHEMA_INVALID'
          ? 'The parser returned a result that did not match its contract. Nothing was changed; you can try again.'
          : 'The parser could not be reached. Nothing was changed; you can try again.',
        { errorCode: outcome.errorCode },
        true,
      );
    });
  }

  const parsed = outcome.value;

  // --- deterministic: catalogue, units, quantities --------------------------
  return withTenant(organizationId, async (tx) => {
    const corpus = await loadMatchCorpus(tx);

    // Re-parsing replaces the machine's proposals. Human decisions are not preserved across a
    // re-parse: the items they applied to may no longer exist, and silently carrying a
    // confirmation onto a different line is worse than asking again.
    await tx.inquiryItemProposal.deleteMany({ where: { inquiryId } });

    let position = 0;
    let written = 0;

    for (const item of parsed.items) {
      const quantityProblem = validateQuantity(item.quantity);
      if (quantityProblem) {
        // The schema already bounds quantity, so reaching here means a provider slipped through
        // a value the contract permits and the business does not. Skip the line rather than
        // storing a quantity nothing downstream can use.
        continue;
      }

      const outcomeForItem = matchProduct(item.rawName, corpus);
      const requestedUnit = normalizeUnit(item.unit ?? null);

      await tx.inquiryItemProposal.create({
        data: {
          organizationId: context.organizationId,
          inquiryId,
          position,
          rawName: item.rawName,
          requestedQuantity: item.quantity,
          requestedUnit,
          proposedProductId: outcomeForItem.best?.productId ?? null,
          proposedConfidence: outcomeForItem.best ? outcomeForItem.confidence : null,
          matchMethod: outcomeForItem.method,
          matchReason: outcomeForItem.reason,
          ambiguous: outcomeForItem.ambiguous,
          candidates: outcomeForItem.candidates.map((candidate) => ({
            productId: candidate.productId,
            sku: candidate.sku,
            name: candidate.name,
            unit: candidate.unit,
            confidence: candidate.confidence,
            method: candidate.method,
            reason: candidate.reason,
          })),
          // Nothing is matched until a person says so. The machine's opinion lives in the
          // proposed* columns; this column is the human's answer and starts empty.
          matchedProductId: null,
          reviewStatus: outcomeForItem.best ? 'SUGGESTED' : 'UNRESOLVED',
        },
      });

      position += 1;
      written += 1;
    }

    await tx.aiInteraction.create({
      data: {
        organizationId: context.organizationId,
        inquiryId,
        purpose: 'parse_inquiry',
        provider: outcome.meta.provider,
        model: outcome.meta.model,
        promptVersion: outcome.meta.promptVersion,
        inputFingerprint: fingerprint,
        valid: true,
        itemCount: written,
        latencyMs: outcome.meta.latencyMs,
      },
    });

    const moved = await transition(tx, context, inquiryId, 'PARSING', 'NEEDS_REVIEW', {
      intent: parsed.intent,
      detectedLanguage: parsed.detectedLanguage,
      destinationText: parsed.destinationText,
      parsedCustomerName: parsed.customerName,
      parsedAt: new Date(),
      parseError: null,
    });
    if (!moved.ok) return moved;

    await recordAudit(tx, context, {
      action: 'inquiry.parse_succeeded',
      entityType: 'inquiry',
      entityId: inquiryId,
      newState: {
        intent: parsed.intent,
        detectedLanguage: parsed.detectedLanguage,
        itemCount: written,
        provider: outcome.meta.provider,
        promptVersion: outcome.meta.promptVersion,
      },
      aiInvolved: true,
    });

    return ok({ status: 'NEEDS_REVIEW' as InquiryStatus, itemCount: written });
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface InquiryItemView {
  readonly id: string;
  readonly position: number;
  readonly rawName: string;
  readonly requestedQuantity: number;
  readonly requestedUnit: string | null;
  readonly matchMethod: string;
  readonly matchReason: string;
  readonly ambiguous: boolean;
  readonly proposedConfidence: number | null;
  readonly band: ConfidenceBand;
  readonly reviewStatus: 'SUGGESTED' | 'CONFIRMED' | 'CORRECTED' | 'UNRESOLVED' | 'REJECTED';
  readonly candidates: readonly Pick<
    MatchCandidate,
    'productId' | 'sku' | 'name' | 'unit' | 'confidence' | 'method' | 'reason'
  >[];
  /** The product currently in play: the human's choice if made, otherwise the machine's. */
  readonly product: {
    readonly id: string;
    readonly sku: string;
    readonly name: string;
    readonly unit: string;
    readonly sellingPriceMinor: bigint;
    readonly availableStock: number;
    readonly reservedStock: number;
    readonly freeStock: number;
  } | null;
  readonly unitCheck: UnitCheck | null;
  /** Free stock minus requested quantity. Negative means short. Null when no product. */
  readonly stockShortfall: number | null;
  readonly humanDecided: boolean;
}

export interface InquiryView {
  readonly id: string;
  readonly status: InquiryStatus;
  readonly channel: string;
  readonly rawMessage: string;
  readonly detectedLanguage: string | null;
  readonly intent: string;
  readonly destinationText: string | null;
  readonly parsedCustomerName: string | null;
  readonly parseError: string | null;
  readonly customer: { id: string; companyName: string; creditStatus: string } | null;
  readonly createdAt: Date;
  readonly parsedAt: Date | null;
  readonly readyAt: Date | null;
  readonly items: readonly InquiryItemView[];
  readonly readiness: ReadinessVerdict;
}

type CandidateJson = InquiryItemView['candidates'][number];

export async function getInquiry(
  tx: TenantTransaction,
  id: string,
): Promise<Result<InquiryView>> {
  const inquiry = await tx.inquiry.findFirst({
    where: { id },
    include: {
      customer: { select: { id: true, companyName: true, creditStatus: true } },
      items: {
        orderBy: { position: 'asc' },
        include: {
          matchedProduct: true,
          proposedProduct: true,
        },
      },
    },
  });

  if (!inquiry) return fail('NOT_FOUND', 'error.notFound');

  const items: InquiryItemView[] = inquiry.items.map((item) => {
    // The human's choice wins when made. Both relations are tenant-scoped by the extension, so
    // a product from another organization cannot appear here even if an id were planted.
    const product = item.matchedProduct ?? item.proposedProduct ?? null;
    const confidence = item.proposedConfidence === null ? null : Number(item.proposedConfidence);

    const unitCheck = product ? checkUnit(item.requestedUnit, product.unit) : null;
    const free = product ? freeStock(product) : null;

    return {
      id: item.id,
      position: item.position,
      rawName: item.rawName,
      requestedQuantity: item.requestedQuantity,
      requestedUnit: item.requestedUnit,
      matchMethod: item.matchMethod,
      matchReason: item.matchReason,
      ambiguous: item.ambiguous,
      proposedConfidence: confidence,
      band: confidenceBand(confidence ?? 0),
      reviewStatus: item.reviewStatus,
      candidates: Array.isArray(item.candidates) ? (item.candidates as CandidateJson[]) : [],
      product: product
        ? {
            id: product.id,
            sku: product.sku,
            name: product.name,
            unit: product.unit,
            sellingPriceMinor: product.sellingPriceMinor,
            availableStock: product.availableStock,
            reservedStock: product.reservedStock,
            freeStock: freeStock(product),
          }
        : null,
      unitCheck,
      stockShortfall: free === null ? null : free - item.requestedQuantity,
      humanDecided: item.reviewStatus === 'CONFIRMED' || item.reviewStatus === 'CORRECTED',
    };
  });

  const readiness = evaluateReadiness(inquiry.intent, items.map(toReadinessItem));

  return ok({
    id: inquiry.id,
    status: inquiry.status as InquiryStatus,
    channel: inquiry.channel,
    rawMessage: inquiry.rawMessage,
    detectedLanguage: inquiry.detectedLanguage,
    intent: inquiry.intent,
    destinationText: inquiry.destinationText,
    parsedCustomerName: inquiry.parsedCustomerName,
    parseError: inquiry.parseError,
    customer: inquiry.customer,
    createdAt: inquiry.createdAt,
    parsedAt: inquiry.parsedAt,
    readyAt: inquiry.readyAt,
    items,
    readiness,
  });
}

function toReadinessItem(item: InquiryItemView): ReadinessItem {
  return {
    id: item.id,
    position: item.position,
    rawName: item.rawName,
    reviewStatus: item.reviewStatus,
    matchedProductId: item.humanDecided ? (item.product?.id ?? null) : null,
    requestedQuantity: item.requestedQuantity,
    unitCompatibility: item.unitCheck?.compatibility ?? null,
    stockShortfall: item.stockShortfall,
    shortfallUnit: item.product?.unit ?? null,
  };
}

export interface InquiryListRow {
  readonly id: string;
  readonly status: InquiryStatus;
  readonly channel: string;
  readonly normalizedText: string;
  readonly intent: string;
  readonly createdAt: Date;
  readonly customerName: string | null;
  readonly itemCount: number;
  readonly needsAttention: number;
}

export async function listInquiries(
  tx: TenantTransaction,
  options: { status?: InquiryStatus } = {},
): Promise<InquiryListRow[]> {
  const rows = await tx.inquiry.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      customer: { select: { companyName: true } },
      items: { select: { reviewStatus: true, ambiguous: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    status: row.status as InquiryStatus,
    channel: row.channel,
    normalizedText: row.normalizedText,
    intent: row.intent,
    createdAt: row.createdAt,
    customerName: row.customer?.companyName ?? row.parsedCustomerName ?? null,
    itemCount: row.items.length,
    needsAttention: row.items.filter(
      (item) => item.reviewStatus === 'SUGGESTED' || item.reviewStatus === 'UNRESOLVED' || item.ambiguous,
    ).length,
  }));
}

// ---------------------------------------------------------------------------
// Review actions
// ---------------------------------------------------------------------------

async function loadItem(tx: TenantTransaction, itemId: string) {
  return tx.inquiryItemProposal.findFirst({
    where: { id: itemId },
    include: { inquiry: { select: { id: true, status: true } } },
  });
}

/**
 * Every review action funnels through here so that three things always happen together: the
 * change is written, it is audited with the machine's original proposal alongside the human's
 * decision, and an inquiry that had been declared ready is withdrawn from that state.
 *
 * The last part matters. Readiness is a claim about a specific set of reviewed lines; editing
 * one after the fact must retract the claim rather than leave a stale one for Phase 3 to
 * consume — the same reasoning that invalidates an approval when the figures change.
 */
async function applyReview(
  tx: TenantTransaction,
  context: ActorContext,
  itemId: string,
  action: string,
  data: Record<string, unknown>,
  auditState: { oldState: Record<string, unknown>; newState: Record<string, unknown> },
): Promise<Result<null>> {
  const item = await loadItem(tx, itemId);
  if (!item) return fail('NOT_FOUND', 'error.notFound');

  const status = item.inquiry.status as InquiryStatus;
  if (status !== 'NEEDS_REVIEW' && status !== 'READY_FOR_QUOTE') {
    return fail(
      'INVALID_STATE_TRANSITION',
      `Items can only be reviewed while the inquiry needs review; this one is ${status
        .toLowerCase()
        .replace(/_/g, ' ')}.`,
    );
  }

  await tx.inquiryItemProposal.update({
    where: { id: itemId },
    data: { ...data, reviewedById: context.userId, reviewedAt: new Date() },
  });

  await recordAudit(tx, context, {
    action,
    entityType: 'inquiry_item',
    entityId: itemId,
    oldState: auditState.oldState,
    newState: auditState.newState,
    // The machine was involved in producing what the human is acting on, and the confidence it
    // produced is part of the record of that decision.
    aiInvolved: true,
    confidence: item.proposedConfidence === null ? null : Number(item.proposedConfidence),
  });

  if (status === 'READY_FOR_QUOTE') {
    const withdrawn = await transition(
      tx,
      context,
      item.inquiry.id,
      'READY_FOR_QUOTE',
      'NEEDS_REVIEW',
      { readyAt: null },
    );
    if (!withdrawn.ok) return withdrawn;
  }

  await tx.inquiry.update({
    where: { id: item.inquiry.id },
    data: { reviewedAt: new Date() },
  });

  return ok(null);
}

/** Accepts the machine's proposal as it stands. */
export async function confirmItem(
  tx: TenantTransaction,
  context: ActorContext,
  itemId: string,
): Promise<Result<null>> {
  const item = await loadItem(tx, itemId);
  if (!item) return fail('NOT_FOUND', 'error.notFound');
  if (!item.proposedProductId) {
    return fail(
      'VALIDATION_FAILED',
      'There is no proposed product to confirm. Choose one instead.',
    );
  }

  return applyReview(
    tx,
    context,
    itemId,
    'inquiry.item_confirmed',
    { matchedProductId: item.proposedProductId, reviewStatus: 'CONFIRMED' },
    {
      oldState: { reviewStatus: item.reviewStatus, matchedProductId: item.matchedProductId },
      newState: {
        reviewStatus: 'CONFIRMED',
        matchedProductId: item.proposedProductId,
        acceptedProposal: true,
        matchMethod: item.matchMethod,
      },
    },
  );
}

/** Replaces the machine's proposal with a product the salesperson chose. */
export async function correctItemProduct(
  tx: TenantTransaction,
  context: ActorContext,
  itemId: string,
  productId: string,
): Promise<Result<null>> {
  const item = await loadItem(tx, itemId);
  if (!item) return fail('NOT_FOUND', 'error.notFound');

  // Scoped: a product id belonging to another organization is simply not found, so a crafted
  // form post cannot attach a foreign product to this line.
  const product = await tx.product.findFirst({ where: { id: productId, active: true } });
  if (!product) return fail('NOT_FOUND', 'That product is not in this catalogue.');

  return applyReview(
    tx,
    context,
    itemId,
    'inquiry.item_corrected',
    { matchedProductId: productId, reviewStatus: 'CORRECTED' },
    {
      oldState: {
        reviewStatus: item.reviewStatus,
        proposedProductId: item.proposedProductId,
        matchMethod: item.matchMethod,
      },
      newState: {
        reviewStatus: 'CORRECTED',
        matchedProductId: productId,
        productSku: product.sku,
        // Recorded so the correction rate can be told apart from the acceptance rate.
        overrodeProposal: item.proposedProductId !== null && item.proposedProductId !== productId,
      },
    },
  );
}

export const quantityCorrectionSchema = z.object({
  quantity: z.coerce.number().int().positive().max(1_000_000),
  unit: z.string().trim().max(40).nullable().optional(),
});

export async function correctItemQuantity(
  tx: TenantTransaction,
  context: ActorContext,
  itemId: string,
  raw: unknown,
): Promise<Result<null>> {
  const parsed = quantityCorrectionSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', 'Enter a whole quantity greater than zero.', {
      field: 'quantity',
    });
  }

  const item = await loadItem(tx, itemId);
  if (!item) return fail('NOT_FOUND', 'error.notFound');

  const requestedUnit = parsed.data.unit ? normalizeUnit(parsed.data.unit) : item.requestedUnit;

  return applyReview(
    tx,
    context,
    itemId,
    'inquiry.item_quantity_corrected',
    { requestedQuantity: parsed.data.quantity, requestedUnit },
    {
      oldState: { quantity: item.requestedQuantity, unit: item.requestedUnit },
      newState: { quantity: parsed.data.quantity, unit: requestedUnit },
    },
  );
}

/** Says "the parser read something that is not a product request here". */
export async function rejectItem(
  tx: TenantTransaction,
  context: ActorContext,
  itemId: string,
): Promise<Result<null>> {
  const item = await loadItem(tx, itemId);
  if (!item) return fail('NOT_FOUND', 'error.notFound');

  return applyReview(
    tx,
    context,
    itemId,
    'inquiry.item_rejected',
    { reviewStatus: 'REJECTED', matchedProductId: null },
    {
      oldState: { reviewStatus: item.reviewStatus, rawName: item.rawName },
      newState: { reviewStatus: 'REJECTED' },
    },
  );
}

/** Says "this is a real request, but I cannot tell which product it is". */
export async function markItemUnresolved(
  tx: TenantTransaction,
  context: ActorContext,
  itemId: string,
): Promise<Result<null>> {
  const item = await loadItem(tx, itemId);
  if (!item) return fail('NOT_FOUND', 'error.notFound');

  return applyReview(
    tx,
    context,
    itemId,
    'inquiry.item_unresolved',
    { reviewStatus: 'UNRESOLVED', matchedProductId: null },
    {
      oldState: { reviewStatus: item.reviewStatus },
      newState: { reviewStatus: 'UNRESOLVED' },
    },
  );
}

export const manualItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().int().positive().max(1_000_000),
});

/**
 * Adds a line the parser missed entirely.
 *
 * Without this the review screen can only ever subtract from what the machine found, so an
 * inquiry whose last line was dropped could never be made correct — the salesperson would have
 * to abandon the workflow and start a quotation by hand, which is the manual work this product
 * exists to remove.
 */
export async function addManualItem(
  tx: TenantTransaction,
  context: ActorContext,
  inquiryId: string,
  raw: unknown,
): Promise<Result<{ id: string }>> {
  const parsed = manualItemSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', 'Choose a product and a whole quantity greater than zero.');
  }

  const inquiry = await tx.inquiry.findFirst({ where: { id: inquiryId } });
  if (!inquiry) return fail('NOT_FOUND', 'error.notFound');

  const status = inquiry.status as InquiryStatus;
  if (status !== 'NEEDS_REVIEW' && status !== 'READY_FOR_QUOTE') {
    return fail('INVALID_STATE_TRANSITION', 'Items can only be added while the inquiry is in review.');
  }

  const product = await tx.product.findFirst({ where: { id: parsed.data.productId, active: true } });
  if (!product) return fail('NOT_FOUND', 'That product is not in this catalogue.');

  const highest = await tx.inquiryItemProposal.aggregate({
    where: { inquiryId },
    _max: { position: true },
  });

  const created = await tx.inquiryItemProposal.create({
    data: {
      organizationId: context.organizationId,
      inquiryId,
      position: (highest._max.position ?? -1) + 1,
      rawName: product.name,
      requestedQuantity: parsed.data.quantity,
      requestedUnit: product.unit,
      // HUMAN, not FUZZY: the machine never proposed this line, and the match-distribution
      // metric would be misleading if a person's entry counted as a parser success.
      matchMethod: 'HUMAN',
      matchReason: 'Added by a salesperson; the parser did not find this line.',
      proposedProductId: null,
      proposedConfidence: null,
      matchedProductId: product.id,
      reviewStatus: 'CORRECTED',
      reviewedById: context.userId,
      reviewedAt: new Date(),
    },
  });

  await recordAudit(tx, context, {
    action: 'inquiry.item_added',
    entityType: 'inquiry_item',
    entityId: created.id,
    newState: { productSku: product.sku, quantity: parsed.data.quantity, addedByHuman: true },
  });

  if (status === 'READY_FOR_QUOTE') {
    const withdrawn = await transition(tx, context, inquiryId, 'READY_FOR_QUOTE', 'NEEDS_REVIEW', {
      readyAt: null,
    });
    if (!withdrawn.ok) return withdrawn;
  }

  return ok({ id: created.id });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export async function markReadyForQuote(
  tx: TenantTransaction,
  context: ActorContext,
  inquiryId: string,
): Promise<Result<ReadinessVerdict>> {
  const view = await getInquiry(tx, inquiryId);
  if (!view.ok) return view;

  if (view.value.status !== 'NEEDS_REVIEW') {
    return fail(
      'INVALID_STATE_TRANSITION',
      `Only an inquiry under review can be marked ready; this one is ${view.value.status
        .toLowerCase()
        .replace(/_/g, ' ')}.`,
    );
  }

  if (!view.value.readiness.ready) {
    return fail(
      'VALIDATION_FAILED',
      view.value.readiness.blockers[0]?.message ?? 'This inquiry is not ready.',
      { blockers: view.value.readiness.blockers.length },
    );
  }

  const moved = await transition(tx, context, inquiryId, 'NEEDS_REVIEW', 'READY_FOR_QUOTE', {
    readyAt: new Date(),
  });
  if (!moved.ok) return moved;

  await recordAudit(tx, context, {
    action: 'inquiry.ready_for_quote',
    entityType: 'inquiry',
    entityId: inquiryId,
    newState: {
      retainedItems: view.value.readiness.retainedCount,
      warnings: view.value.readiness.warnings.length,
    },
  });

  return ok(view.value.readiness);
}

export async function cancelInquiry(
  tx: TenantTransaction,
  context: ActorContext,
  inquiryId: string,
): Promise<Result<null>> {
  const inquiry = await tx.inquiry.findFirst({ where: { id: inquiryId } });
  if (!inquiry) return fail('NOT_FOUND', 'error.notFound');
  return transition(tx, context, inquiryId, inquiry.status as InquiryStatus, 'CANCELLED');
}
