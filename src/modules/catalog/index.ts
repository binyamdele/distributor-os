import 'server-only';
import { z } from 'zod';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { type Result, fail, ok } from '@/platform/result';
import { parseDecimal, toDecimalString } from '@/platform/money';
import { recordAudit } from '@/modules/audit';
import { normalizeAlias, parseAliasList } from './normalize';
import { type MatchOutcome, type MatchableProduct, matchProduct } from './matching';

export { normalizeAlias, parseAliasList };
export * from './matching';
export * from './units';

export const productInputSchema = z.object({
  sku: z.string().trim().min(1, 'error.required').max(60),
  name: z.string().trim().min(1, 'error.required').max(200),
  category: z.string().trim().max(100).optional().or(z.literal('')),
  unit: z.string().trim().min(1, 'error.required').max(30),
  /** A decimal string typed by a human. Converted to minor units; never a JS number. */
  sellingPrice: z.string().trim().min(1, 'error.required'),
  /** Whole percent in the UI; stored as basis points. */
  taxRatePercent: z.coerce.number().min(0).max(100).default(15),
  availableStock: z.coerce.number().int().min(0).default(0),
  reorderThreshold: z.coerce.number().int().min(0).default(0),
  active: z.coerce.boolean().default(true),
  aliases: z.string().default(''),
});

export type ProductInput = z.infer<typeof productInputSchema>;

export interface ProductRecord {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly category: string | null;
  readonly unit: string;
  readonly sellingPriceMinor: bigint;
  readonly taxRateBp: number;
  readonly availableStock: number;
  readonly reservedStock: number;
  readonly reorderThreshold: number;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProductWithAliases extends ProductRecord {
  readonly aliases: { id: string; alias: string; normalizedAlias: string; source: string }[];
}

/**
 * Free-to-sell stock: what is on hand minus what is already promised to confirmed orders.
 * This — not `availableStock` — is what a quotation checks in Phase 3.
 */
export function freeStock(product: Pick<ProductRecord, 'availableStock' | 'reservedStock'>): number {
  return product.availableStock - product.reservedStock;
}

export function isLowStock(
  product: Pick<ProductRecord, 'availableStock' | 'reservedStock' | 'reorderThreshold'>,
): boolean {
  return product.reorderThreshold > 0 && freeStock(product) <= product.reorderThreshold;
}

export async function listProducts(
  tx: TenantTransaction,
  options: { search?: string; includeInactive?: boolean } = {},
): Promise<ProductRecord[]> {
  const search = options.search?.trim();
  return tx.product.findMany({
    where: {
      ...(options.includeInactive ? {} : { active: true }),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
              { aliases: { some: { normalizedAlias: { contains: normalizeAlias(search) } } } },
            ],
          }
        : {}),
    },
    orderBy: { name: 'asc' },
    take: 200,
  }) as unknown as Promise<ProductRecord[]>;
}

export async function getProduct(
  tx: TenantTransaction,
  id: string,
): Promise<Result<ProductWithAliases>> {
  const found = await tx.product.findFirst({
    where: { id },
    include: { aliases: { orderBy: { alias: 'asc' } } },
  });
  if (!found) return fail('NOT_FOUND', 'error.notFound');
  return ok(found as unknown as ProductWithAliases);
}

export async function createProduct(
  tx: TenantTransaction,
  context: ActorContext,
  raw: unknown,
  currency: string,
): Promise<Result<ProductRecord>> {
  const parsed = productInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'error.generic', {
      field: parsed.error.issues[0]?.path.join('.'),
    });
  }
  const input = parsed.data;

  const price = parseDecimal(input.sellingPrice, currency);
  if (!price.ok) return price;
  if (price.value.amountMinor < 0n) {
    return fail('VALIDATION_FAILED', 'A selling price cannot be negative.', {
      field: 'sellingPrice',
    });
  }

  const duplicate = await tx.product.findFirst({ where: { sku: input.sku } });
  if (duplicate) {
    return fail('CONFLICT', `SKU ${input.sku} already exists.`, { field: 'sku' });
  }

  const aliases = parseAliasList(input.aliases);

  const created = await tx.product.create({
    data: {
      organizationId: context.organizationId,
      sku: input.sku,
      name: input.name,
      category: input.category?.trim() || null,
      unit: input.unit,
      sellingPriceMinor: price.value.amountMinor,
      // Whole percent in, basis points stored: 15 -> 1500. Integer throughout.
      taxRateBp: Math.round(input.taxRatePercent * 100),
      availableStock: input.availableStock,
      reorderThreshold: input.reorderThreshold,
      active: input.active,
      aliases: {
        create: aliases.map((entry) => ({
          organizationId: context.organizationId,
          alias: entry.alias,
          normalizedAlias: entry.normalizedAlias,
          source: 'MANUAL',
          createdById: context.userId,
        })),
      },
    },
  });

  await recordAudit(tx, context, {
    action: 'product.created',
    entityType: 'product',
    entityId: created.id,
    newState: {
      sku: created.sku,
      name: created.name,
      unit: created.unit,
      sellingPrice: toDecimalString({ amountMinor: created.sellingPriceMinor, currency }),
      taxRateBp: created.taxRateBp,
      availableStock: created.availableStock,
      aliasCount: aliases.length,
    },
  });

  return ok(created as unknown as ProductRecord);
}

export const stockAdjustmentSchema = z.object({
  delta: z.coerce.number().int().refine((n) => n !== 0, 'A stock change of zero does nothing.'),
  reason: z.string().trim().min(1, 'error.required').max(200),
});

export interface StockAdjustmentResult {
  readonly productId: string;
  readonly delta: number;
  readonly stockAfter: number;
}

/**
 * Adjusts stock and records why.
 *
 * The update is a single conditional statement rather than a read-then-write. Two warehouse
 * staff adjusting the same product at the same moment would otherwise both read 100, both
 * write their own result, and one adjustment would silently vanish. The `WHERE ... >= 0` also
 * makes "you cannot remove more than you have" a property of the database rather than of a
 * check that ran a moment earlier.
 *
 * `organization_id` is in the WHERE clause explicitly: raw SQL bypasses the Prisma extension,
 * so the tenancy filter has to be written here. RLS is still in force underneath.
 */
export async function adjustStock(
  tx: TenantTransaction,
  context: ActorContext,
  productId: string,
  raw: unknown,
): Promise<Result<StockAdjustmentResult>> {
  const parsed = stockAdjustmentSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'error.generic', {
      field: parsed.error.issues[0]?.path.join('.'),
    });
  }
  const { delta, reason } = parsed.data;

  const rows = await tx.$queryRaw<{ available_stock: number }[]>`
    UPDATE products
       SET available_stock = available_stock + ${delta},
           updated_at = now()
     WHERE id = ${productId}::uuid
       AND organization_id = ${context.organizationId}::uuid
       AND available_stock + ${delta} >= 0
    RETURNING available_stock
  `;

  const updated = rows[0];
  if (!updated) {
    // Either the product is not in this organization, or the change would drive stock below
    // zero. Both are refusals; distinguishing them requires a second read that would tell an
    // unauthorised caller whether the id exists.
    const exists = await tx.product.findFirst({ where: { id: productId } });
    if (!exists) return fail('NOT_FOUND', 'error.notFound');
    return fail(
      'INSUFFICIENT_STOCK',
      `Only ${exists.availableStock} in stock; that change would leave a negative balance.`,
      { field: 'delta', available: exists.availableStock },
    );
  }

  const stockAfter = Number(updated.available_stock);

  await tx.stockAdjustment.create({
    data: {
      organizationId: context.organizationId,
      productId,
      delta,
      stockAfter,
      reason,
      actorId: context.userId,
    },
  });

  await recordAudit(tx, context, {
    action: 'product.stock_adjusted',
    entityType: 'product',
    entityId: productId,
    oldState: { availableStock: stockAfter - delta },
    newState: { availableStock: stockAfter, delta, reason },
  });

  return ok({ productId, delta, stockAfter });
}

export interface StockAdjustmentRecord {
  readonly id: string;
  readonly delta: number;
  readonly stockAfter: number;
  readonly reason: string;
  readonly actorId: string | null;
  readonly createdAt: Date;
}

export async function stockHistory(
  tx: TenantTransaction,
  productId: string,
  limit = 25,
): Promise<StockAdjustmentRecord[]> {
  return tx.stockAdjustment.findMany({
    where: { productId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  }) as unknown as Promise<StockAdjustmentRecord[]>;
}

// ---------------------------------------------------------------------------
// Phase 2 — the corpus the deterministic matcher scores against
// ---------------------------------------------------------------------------

/**
 * Loads this organization's matchable catalogue.
 *
 * This is the single point at which tenancy and matching meet, and the reason the matcher
 * itself takes a corpus rather than a database handle: another organization's products are
 * never in the set being scored, so there is no filter that could be forgotten later. The
 * query goes through the tenant-scoped client, and RLS stands behind it.
 *
 * Inactive products are excluded — quoting something the distributor has withdrawn is worse
 * than failing to match it.
 */
export async function loadMatchCorpus(tx: TenantTransaction): Promise<MatchableProduct[]> {
  const products = await tx.product.findMany({
    where: { active: true },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      aliases: { select: { normalizedAlias: true } },
    },
    orderBy: { sku: 'asc' },
  });

  return products.map((product) => ({
    id: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
    aliases: product.aliases.map((alias) => alias.normalizedAlias),
  }));
}

/** Convenience for one-off lookups; prefer loading the corpus once per inquiry. */
export async function findProductCandidates(
  tx: TenantTransaction,
  rawName: string,
): Promise<MatchOutcome> {
  return matchProduct(rawName, await loadMatchCorpus(tx));
}
