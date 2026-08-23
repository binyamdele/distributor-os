import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { type Result, fail, ok } from '@/platform/result';
import { recordAudit } from '@/modules/audit';
import { normalizeAlias } from '@/modules/catalog';
import {
  type CustomerRow,
  type OpeningStockRow,
  type ProductRow,
  type RowIssue,
  fileFingerprint,
  hasErrors,
  parseCustomers,
  parseOpeningStock,
  parseProducts,
} from './templates';

export * from './csv';
export * from './templates';

/**
 * Pilot data import.
 *
 * A distributor arrives with three spreadsheets: customers, products with prices, and a stock
 * count. Typing them in is a week of work and a hundred opportunities to mistype a price, so
 * this exists — and it is the only product-adjacent feature Phase 9 adds.
 *
 * Three rules shape it, and each one is a mistake somebody has made before:
 *
 *   1. **Nothing is written until a person has seen what will happen.** Parse, validate,
 *      preview, then commit as a separate act. An import that writes on upload is one where the
 *      first time anyone reads the errors is after they are in the database.
 *   2. **All or nothing, per file.** Partial import leaves a distributor with half a catalogue
 *      and no clear way to work out which half. "Fix the file and run it again" is an
 *      instruction anyone can follow; "find the 43 rows that did not import" is not.
 *   3. **Opening stock cannot be imported twice.** A duplicated customer list is visible and
 *      deletable. A duplicated stock count is invisible: every figure is plausible, the ledger
 *      is consistent, and it is discovered when a physical count disagrees weeks later.
 */

export interface ImportPreview<T> {
  readonly kind: 'CUSTOMERS' | 'PRODUCTS' | 'OPENING_STOCK';
  readonly fingerprint: string;
  readonly rows: readonly T[];
  readonly issues: readonly RowIssue[];
  /** Rows that would be created, versus rows that match something already present. */
  readonly toCreate: number;
  readonly toUpdate: number;
  readonly canCommit: boolean;
  /** Why not, when `canCommit` is false. Already a complete sentence. */
  readonly blockedReason: string | null;
  /** Set when this exact file has been imported before. */
  readonly alreadyImportedAt: Date | null;
}

async function priorImport(
  tx: TenantTransaction,
  kind: ImportPreview<unknown>['kind'],
  fingerprint: string,
): Promise<Date | null> {
  const existing = await tx.importJob.findFirst({
    where: { kind, fingerprint },
    select: { createdAt: true },
  });
  return existing?.createdAt ?? null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function previewCustomers(
  tx: TenantTransaction,
  content: string,
): Promise<Result<ImportPreview<CustomerRow>>> {
  const parsed = parseCustomers(content);
  if (parsed.fatal) return fail('VALIDATION_FAILED', parsed.fatal);

  const fingerprint = fileFingerprint(content);
  const alreadyImportedAt = await priorImport(tx, 'CUSTOMERS', fingerprint);

  // Which names already exist. Compared case-insensitively for the same reason the file's own
  // duplicate check is: one customer with two spellings becomes two ledgers for one debtor.
  const existing = await tx.customer.findMany({ select: { companyName: true } });
  const existingNames = new Set(existing.map((row) => row.companyName.toLowerCase()));

  const toUpdate = parsed.rows.filter((row) =>
    existingNames.has(row.companyName.toLowerCase()),
  ).length;

  const blocked = hasErrors(parsed.issues);

  return ok({
    kind: 'CUSTOMERS',
    fingerprint,
    rows: parsed.rows,
    issues: parsed.issues,
    toCreate: parsed.rows.length - toUpdate,
    toUpdate,
    canCommit: !blocked && parsed.rows.length > 0,
    blockedReason: blocked
      ? 'Some rows have errors. Nothing is imported until every row is valid.'
      : parsed.rows.length === 0
        ? 'The file has no rows to import.'
        : null,
    alreadyImportedAt,
  });
}

export interface ImportOutcome {
  readonly created: number;
  readonly updated: number;
  readonly jobId: string;
}

export async function commitCustomers(
  tx: TenantTransaction,
  context: ActorContext,
  content: string,
  options: { filename?: string; acknowledgeDuplicate?: boolean } = {},
): Promise<Result<ImportOutcome>> {
  const preview = await previewCustomers(tx, content);
  if (!preview.ok) return preview;

  // Validated again server-side rather than trusting whatever the preview returned. The preview
  // is a read; the client could have edited the file between the two calls.
  if (!preview.value.canCommit) {
    return fail('VALIDATION_FAILED', preview.value.blockedReason ?? 'This file cannot be imported.');
  }

  if (preview.value.alreadyImportedAt && !options.acknowledgeDuplicate) {
    return fail(
      'CONFLICT',
      `This exact file was already imported on ${preview.value.alreadyImportedAt.toISOString().slice(0, 10)}. ` +
        'Import it again only if you meant to.',
      { alreadyImportedAt: preview.value.alreadyImportedAt },
    );
  }

  let created = 0;
  let updated = 0;

  for (const row of preview.value.rows) {
    const existing = await tx.customer.findFirst({
      where: { companyName: { equals: row.companyName, mode: 'insensitive' } },
      select: { id: true },
    });

    const data = {
      contactName: row.contactName,
      phone: row.phone,
      email: row.email,
      address: row.address,
      creditStatus: row.creditStatus,
      creditLimitMinor: row.creditLimitMinor,
      paymentTermsDays: row.paymentTermsDays,
    };

    if (existing) {
      await tx.customer.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await tx.customer.create({
        data: { organizationId: context.organizationId, companyName: row.companyName, ...data },
      });
      created += 1;
    }
  }

  const job = await tx.importJob.create({
    data: {
      organizationId: context.organizationId,
      kind: 'CUSTOMERS',
      fingerprint: preview.value.fingerprint,
      filename: options.filename ?? null,
      rowCount: preview.value.rows.length,
      createdCount: created,
      updatedCount: updated,
      importedById: context.userId,
    },
  });

  await recordAudit(tx, context, {
    action: 'import.customers',
    entityType: 'import_job',
    entityId: job.id,
    newState: { rows: preview.value.rows.length, created, updated, filename: options.filename },
  });

  return ok({ created, updated, jobId: job.id });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export async function previewProducts(
  tx: TenantTransaction,
  content: string,
): Promise<Result<ImportPreview<ProductRow>>> {
  const parsed = parseProducts(content);
  if (parsed.fatal) return fail('VALIDATION_FAILED', parsed.fatal);

  const fingerprint = fileFingerprint(content);
  const alreadyImportedAt = await priorImport(tx, 'PRODUCTS', fingerprint);

  const existing = await tx.product.findMany({ select: { sku: true } });
  const existingSkus = new Set(existing.map((row) => row.sku.toUpperCase()));
  const toUpdate = parsed.rows.filter((row) => existingSkus.has(row.sku)).length;

  const blocked = hasErrors(parsed.issues);

  return ok({
    kind: 'PRODUCTS',
    fingerprint,
    rows: parsed.rows,
    issues: parsed.issues,
    toCreate: parsed.rows.length - toUpdate,
    toUpdate,
    canCommit: !blocked && parsed.rows.length > 0,
    blockedReason: blocked
      ? 'Some rows have errors. Nothing is imported until every row is valid.'
      : parsed.rows.length === 0
        ? 'The file has no rows to import.'
        : null,
    alreadyImportedAt,
  });
}

export async function commitProducts(
  tx: TenantTransaction,
  context: ActorContext,
  content: string,
  options: { filename?: string; acknowledgeDuplicate?: boolean } = {},
): Promise<Result<ImportOutcome>> {
  const preview = await previewProducts(tx, content);
  if (!preview.ok) return preview;

  if (!preview.value.canCommit) {
    return fail('VALIDATION_FAILED', preview.value.blockedReason ?? 'This file cannot be imported.');
  }

  if (preview.value.alreadyImportedAt && !options.acknowledgeDuplicate) {
    return fail(
      'CONFLICT',
      `This exact file was already imported on ${preview.value.alreadyImportedAt.toISOString().slice(0, 10)}. ` +
        'Import it again only if you meant to.',
    );
  }

  let created = 0;
  let updated = 0;

  for (const row of preview.value.rows) {
    const existing = await tx.product.findFirst({ where: { sku: row.sku }, select: { id: true } });

    /*
     * Stock is deliberately absent from this payload.
     *
     * A catalogue import sets what a product *is* and what it costs. Quantities come from the
     * opening-stock import or from a counted adjustment, and never from a price list — otherwise
     * re-importing an updated price file would silently reset the yard to whatever number was in
     * a column nobody was thinking about.
     */
    const data = {
      name: row.name,
      category: row.category,
      unit: row.unit,
      sellingPriceMinor: row.sellingPriceMinor,
      taxRateBp: row.taxRateBp,
      reorderThreshold: row.reorderThreshold,
    };

    if (existing) {
      await tx.product.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      const product = await tx.product.create({
        data: { organizationId: context.organizationId, sku: row.sku, ...data },
      });

      // The product's own name as its first alias, so Phase 2's matcher can find it from day
      // one. Everything else a distributor's customers actually call it gets added by use.
      const normalized = normalizeAlias(row.name);
      if (normalized) {
        await tx.productAlias.create({
          data: {
            organizationId: context.organizationId,
            productId: product.id,
            alias: row.name,
            normalizedAlias: normalized,
            // MANUAL, because a person supplied it in a spreadsheet — as opposed to LEARNED,
            // which Phase 2 reserves for aliases the matcher acquired from real inquiries.
            source: 'MANUAL',
          },
        });
      }
      created += 1;
    }
  }

  const job = await tx.importJob.create({
    data: {
      organizationId: context.organizationId,
      kind: 'PRODUCTS',
      fingerprint: preview.value.fingerprint,
      filename: options.filename ?? null,
      rowCount: preview.value.rows.length,
      createdCount: created,
      updatedCount: updated,
      importedById: context.userId,
    },
  });

  await recordAudit(tx, context, {
    action: 'import.products',
    entityType: 'import_job',
    entityId: job.id,
    newState: { rows: preview.value.rows.length, created, updated, filename: options.filename },
  });

  return ok({ created, updated, jobId: job.id });
}

// ---------------------------------------------------------------------------
// Opening stock
// ---------------------------------------------------------------------------

export interface OpeningStockPreview extends ImportPreview<OpeningStockRow> {
  /** SKUs in the file that are not in the catalogue. Always an error. */
  readonly unknownSkus: readonly string[];
  /** SKUs that already hold stock. Importing an opening balance over one is refused. */
  readonly alreadyStocked: readonly string[];
}

export async function previewOpeningStock(
  tx: TenantTransaction,
  content: string,
): Promise<Result<OpeningStockPreview>> {
  const parsed = parseOpeningStock(content);
  if (parsed.fatal) return fail('VALIDATION_FAILED', parsed.fatal);

  const fingerprint = fileFingerprint(content);
  const alreadyImportedAt = await priorImport(tx, 'OPENING_STOCK', fingerprint);

  const products = await tx.product.findMany({
    select: { id: true, sku: true, availableStock: true },
  });
  const bySku = new Map(products.map((row) => [row.sku.toUpperCase(), row]));

  const issues: RowIssue[] = [...parsed.issues];
  const unknownSkus: string[] = [];
  const alreadyStocked: string[] = [];

  parsed.rows.forEach((row, index) => {
    const line = parsed.lineNumbers[index]!;
    const product = bySku.get(row.sku);

    if (!product) {
      unknownSkus.push(row.sku);
      issues.push({
        line,
        column: 'sku',
        severity: 'error',
        message: `"${row.sku}" is not in the catalogue. Import products first.`,
      });
      return;
    }

    /*
     * A product that already holds stock cannot receive an opening balance.
     *
     * This is the second line of defence behind the file fingerprint, and it catches the case
     * the fingerprint cannot: a *different* file — re-exported, one row edited, saved under a
     * new name — covering products that were already counted. Without it, "opening stock" would
     * quietly become "add this much stock", and the yard would double with every attempt.
     */
    if (product.availableStock !== 0) {
      alreadyStocked.push(row.sku);
      issues.push({
        line,
        column: 'sku',
        severity: 'error',
        message: `"${row.sku}" already holds ${product.availableStock}. An opening balance is set once; use a stock adjustment to correct a count.`,
      });
    }
  });

  const blocked = hasErrors(issues);

  return ok({
    kind: 'OPENING_STOCK',
    fingerprint,
    rows: parsed.rows,
    issues,
    toCreate: parsed.rows.length,
    toUpdate: 0,
    canCommit: !blocked && parsed.rows.length > 0,
    blockedReason: blocked
      ? 'Some rows have errors. Nothing is imported until every row is valid.'
      : parsed.rows.length === 0
        ? 'The file has no rows to import.'
        : null,
    alreadyImportedAt,
    unknownSkus,
    alreadyStocked,
  });
}

/**
 * Sets opening balances, and records each one in the ledger.
 *
 * §37: opening stock must not simply appear. Every later movement is a change *from* a baseline,
 * and if the baseline itself has no row then the ledger cannot explain where a product's
 * quantity came from — which defeats the point of Phase 7 building the ledger at all.
 *
 * There is no `acknowledgeDuplicate` escape here, unlike customers and products. Re-importing a
 * customer list produces visible duplicates somebody can delete; re-importing a stock count
 * produces plausible, invisible, wrong numbers. The refusal is absolute, and the way to correct
 * a bad opening count is a counted stock adjustment — a second recorded fact, as everywhere else
 * in this codebase.
 */
export async function commitOpeningStock(
  tx: TenantTransaction,
  context: ActorContext,
  content: string,
  options: { filename?: string } = {},
): Promise<Result<ImportOutcome>> {
  const preview = await previewOpeningStock(tx, content);
  if (!preview.ok) return preview;

  if (!preview.value.canCommit) {
    return fail('VALIDATION_FAILED', preview.value.blockedReason ?? 'This file cannot be imported.');
  }

  if (preview.value.alreadyImportedAt) {
    return fail(
      'CONFLICT',
      `This exact stock file was already imported on ${preview.value.alreadyImportedAt.toISOString().slice(0, 10)}. ` +
        'Importing it again would double the counts. Use a stock adjustment to correct a figure.',
      { alreadyImportedAt: preview.value.alreadyImportedAt },
      true,
    );
  }

  const products = await tx.product.findMany({ select: { id: true, sku: true } });
  const bySku = new Map(products.map((row) => [row.sku.toUpperCase(), row.id]));

  let created = 0;

  // Sorted by SKU so two concurrent imports touching the same catalogue take row locks in the
  // same order — the Phase 4 lock-ordering rule, applied here for the same reason.
  const rows = [...preview.value.rows].sort((a, b) => a.sku.localeCompare(b.sku));

  for (const row of rows) {
    const productId = bySku.get(row.sku)!;

    // Conditional on the stock still being zero. The preview checked it; this re-checks inside
    // the transaction, so a count that arrived in between cannot be silently overwritten.
    const updated = await tx.$executeRaw`
      UPDATE products
         SET available_stock = ${row.quantity},
             updated_at = now()
       WHERE id = ${productId}::uuid
         AND organization_id = ${context.organizationId}::uuid
         AND available_stock = 0
    `;

    if (updated === 0) {
      return fail(
        'CONFLICT',
        `${row.sku} received stock while this import was being reviewed. Nothing has been imported; check the count and try again.`,
        undefined,
        true,
      );
    }

    if (row.quantity > 0) {
      await tx.inventoryMovement.create({
        data: {
          organizationId: context.organizationId,
          productId,
          movementType: 'OPENING_BALANCE',
          delta: row.quantity,
          stockAfter: row.quantity,
          reason: `Opening balance imported${options.filename ? ` from ${options.filename}` : ''}`,
          actorId: context.userId,
        },
      });
    }

    created += 1;
  }

  const job = await tx.importJob.create({
    data: {
      organizationId: context.organizationId,
      kind: 'OPENING_STOCK',
      fingerprint: preview.value.fingerprint,
      filename: options.filename ?? null,
      rowCount: preview.value.rows.length,
      createdCount: created,
      updatedCount: 0,
      importedById: context.userId,
    },
  });

  await recordAudit(tx, context, {
    action: 'import.opening_stock',
    entityType: 'import_job',
    entityId: job.id,
    newState: {
      rows: preview.value.rows.length,
      products: created,
      totalUnits: preview.value.rows.reduce((sum, row) => sum + row.quantity, 0),
      filename: options.filename,
    },
  });

  return ok({ created, updated: 0, jobId: job.id });
}
