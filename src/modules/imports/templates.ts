import { createHash } from 'node:crypto';
import { parseCsv } from './csv';

/**
 * The three import templates, and the validation that decides what a preview shows.
 *
 * Pure — no database, no I/O — so every rule below is enumerable in a unit test rather than
 * inferred from a transaction. The database checks that need real rows (does this SKU already
 * exist, is this customer a duplicate) happen in the commit path; everything here is what can be
 * decided from the file alone.
 *
 * ## Errors and warnings are different things
 *
 * An **error** stops the file. A **warning** is something the operator should see and may
 * legitimately intend. Getting this wrong in either direction is costly: treat everything as an
 * error and a distributor cannot import a catalogue where two products share a price; treat
 * everything as a warning and somebody imports a negative stock figure without noticing.
 */

export type Severity = 'error' | 'warning';

export interface RowIssue {
  readonly line: number;
  readonly column: string;
  readonly severity: Severity;
  readonly message: string;
}

export interface CustomerRow {
  readonly companyName: string;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly creditStatus: 'CASH_ONLY' | 'CREDIT_ALLOWED' | 'SUSPENDED';
  readonly creditLimitMinor: bigint;
  readonly paymentTermsDays: number;
}

export interface ProductRow {
  readonly sku: string;
  readonly name: string;
  readonly category: string | null;
  readonly unit: string;
  readonly sellingPriceMinor: bigint;
  readonly taxRateBp: number;
  readonly reorderThreshold: number;
}

export interface OpeningStockRow {
  readonly sku: string;
  readonly quantity: number;
}

export const CUSTOMER_HEADERS = [
  'company_name',
  'contact_name',
  'phone',
  'email',
  'address',
  'credit_status',
  'credit_limit',
  'payment_terms_days',
] as const;

export const PRODUCT_HEADERS = [
  'sku',
  'name',
  'category',
  'unit',
  'selling_price',
  'tax_rate_percent',
  'reorder_threshold',
] as const;

export const OPENING_STOCK_HEADERS = ['sku', 'quantity'] as const;

/**
 * Units a distributor actually sells in.
 *
 * A closed list rather than free text, because "bag", "Bags", "BAG" and "bg" in one catalogue
 * makes every quantity on every quotation ambiguous — and by the time anyone notices, the
 * ambiguity is in six months of orders.
 */
export const ALLOWED_UNITS = [
  'bag',
  'piece',
  'kg',
  'ton',
  'litre',
  'm',
  'm2',
  'm3',
  'roll',
  'box',
  'set',
  'unit',
] as const;

/**
 * Parses a decimal amount into integer minor units.
 *
 * Never `parseFloat`. `parseFloat('1250.10') * 100` is 125009.99999999999, and a catalogue
 * imported that way is wrong by a santim on entry — which then propagates into every quotation
 * total the product spent eight phases making exact.
 */
/*
 * ## Why the separators are validated rather than stripped
 *
 * An earlier version of this stripped every comma and space before parsing. That turned the
 * European `1 250,00` — which a spreadsheet exported under a French or German locale writes for
 * one thousand two hundred and fifty — into `125000`. A **hundredfold** error, silently, on
 * every price in the file. Every resulting figure looks entirely plausible; the catalogue is
 * simply wrong by two orders of magnitude, and nobody finds out until a customer queries a
 * quotation weeks later.
 *
 * So exactly one convention is accepted: `.` for the decimal point, `,` only in well-formed
 * groups of three, and no internal spaces at all. Anything else is refused rather than guessed
 * at. Refusing a European export costs the operator one re-save; accepting one costs them their
 * prices.
 */
const PLAIN_AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
const GROUPED_AMOUNT = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;

export function parseMoneyToMinor(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Internal whitespace is refused outright: it is the other half of the European convention,
  // and a number written with it is one whose decimal separator cannot be trusted.
  if (/\s/.test(trimmed)) return null;

  if (!PLAIN_AMOUNT.test(trimmed) && !GROUPED_AMOUNT.test(trimmed)) return null;

  const [whole, fraction = ''] = trimmed.replace(/,/g, '').split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

const PLAIN_INTEGER = /^-?\d{1,9}$/;
const GROUPED_INTEGER = /^-?\d{1,3}(,\d{3})+$/;

export function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) return null;

  if (!PLAIN_INTEGER.test(trimmed) && !GROUPED_INTEGER.test(trimmed)) return null;
  return Number(trimmed.replace(/,/g, ''));
}

/** Ethiopian mobile numbers, plus a general international form. Advisory, never blocking. */
function looksLikePhone(value: string): boolean {
  const cleaned = value.replace(/[\s-]/g, '');
  return /^(\+?251\d{9}|0\d{9}|\+\d{7,15})$/.test(cleaned);
}

export interface ParsedImport<T> {
  readonly rows: readonly T[];
  readonly issues: readonly RowIssue[];
  /** Rows parsed and their line numbers, aligned. */
  readonly lineNumbers: readonly number[];
  readonly fatal: string | null;
}

function empty<T>(fatal: string): ParsedImport<T> {
  return { rows: [], issues: [], lineNumbers: [], fatal };
}

export function parseCustomers(input: string): ParsedImport<CustomerRow> {
  const parsed = parseCsv(input, CUSTOMER_HEADERS);
  if (!parsed.ok) return empty(parsed.error);

  const rows: CustomerRow[] = [];
  const issues: RowIssue[] = [];
  const lineNumbers: number[] = [];
  const seenNames = new Map<string, number>();

  parsed.table.rows.forEach((row, index) => {
    const line = parsed.table.lineNumbers[index]!;
    const add = (column: string, severity: Severity, message: string) =>
      issues.push({ line, column, severity, message });

    const companyName = row.company_name ?? '';
    if (!companyName) {
      add('company_name', 'error', 'A company name is required.');
      return;
    }

    // Case-insensitive, because "ABC Construction" and "abc construction" are one customer and
    // importing both produces two ledgers for one debtor.
    const key = companyName.toLowerCase();
    const previous = seenNames.get(key);
    if (previous !== undefined) {
      add('company_name', 'error', `Duplicate of the customer on line ${previous}.`);
      return;
    }
    seenNames.set(key, line);

    const rawStatus = (row.credit_status ?? '').toUpperCase() || 'CASH_ONLY';
    if (!['CASH_ONLY', 'CREDIT_ALLOWED', 'SUSPENDED'].includes(rawStatus)) {
      add(
        'credit_status',
        'error',
        `"${row.credit_status}" is not a credit status. Use CASH_ONLY, CREDIT_ALLOWED or SUSPENDED.`,
      );
      return;
    }
    const creditStatus = rawStatus as CustomerRow['creditStatus'];

    const creditLimitRaw = row.credit_limit ?? '';
    const creditLimitMinor = creditLimitRaw ? parseMoneyToMinor(creditLimitRaw) : 0n;
    if (creditLimitMinor === null) {
      add('credit_limit', 'error', `"${creditLimitRaw}" is not a valid amount.`);
      return;
    }

    const termsRaw = row.payment_terms_days ?? '';
    const paymentTermsDays = termsRaw ? parseWholeNumber(termsRaw) : 0;
    if (paymentTermsDays === null || paymentTermsDays < 0 || paymentTermsDays > 365) {
      add(
        'payment_terms_days',
        'error',
        `"${termsRaw}" is not a number of days between 0 and 365.`,
      );
      return;
    }

    /*
     * Credit terms with no limit, warned rather than refused.
     *
     * It is very often a mistake — the operator meant to fill the column in — and it is
     * occasionally deliberate, for a customer the owner trusts without a cap. Refusing would
     * make the second case impossible; staying silent would make the first case invisible.
     */
    if (creditStatus === 'CREDIT_ALLOWED' && creditLimitMinor === 0n) {
      add('credit_limit', 'warning', 'Credit is allowed but the limit is zero.');
    }

    const phone = row.phone || null;
    if (phone && !looksLikePhone(phone)) {
      add('phone', 'warning', `"${phone}" does not look like a phone number.`);
    }

    const email = row.email || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      add('email', 'warning', `"${email}" does not look like an email address.`);
    }

    rows.push({
      companyName,
      contactName: row.contact_name || null,
      phone,
      email,
      address: row.address || null,
      creditStatus,
      creditLimitMinor,
      paymentTermsDays,
    });
    lineNumbers.push(line);
  });

  return { rows, issues, lineNumbers, fatal: null };
}

export function parseProducts(input: string): ParsedImport<ProductRow> {
  const parsed = parseCsv(input, PRODUCT_HEADERS);
  if (!parsed.ok) return empty(parsed.error);

  const rows: ProductRow[] = [];
  const issues: RowIssue[] = [];
  const lineNumbers: number[] = [];
  const seenSkus = new Map<string, number>();

  parsed.table.rows.forEach((row, index) => {
    const line = parsed.table.lineNumbers[index]!;
    const add = (column: string, severity: Severity, message: string) =>
      issues.push({ line, column, severity, message });

    const sku = (row.sku ?? '').toUpperCase();
    if (!sku) {
      add('sku', 'error', 'A SKU is required.');
      return;
    }
    if (!/^[A-Z0-9][A-Z0-9\-_.]{0,39}$/.test(sku)) {
      add('sku', 'error', `"${row.sku}" is not a valid SKU (letters, digits, - _ . only).`);
      return;
    }

    const previous = seenSkus.get(sku);
    if (previous !== undefined) {
      add('sku', 'error', `Duplicate SKU; already used on line ${previous}.`);
      return;
    }
    seenSkus.set(sku, line);

    const name = row.name ?? '';
    if (!name) {
      add('name', 'error', 'A product name is required.');
      return;
    }

    const unit = (row.unit ?? '').toLowerCase();
    if (!unit) {
      add('unit', 'error', 'A unit is required.');
      return;
    }
    if (!ALLOWED_UNITS.includes(unit as (typeof ALLOWED_UNITS)[number])) {
      add(
        'unit',
        'error',
        `"${row.unit}" is not a known unit. Use one of: ${ALLOWED_UNITS.join(', ')}.`,
      );
      return;
    }

    const priceRaw = row.selling_price ?? '';
    const sellingPriceMinor = parseMoneyToMinor(priceRaw);
    if (sellingPriceMinor === null) {
      add('selling_price', 'error', `"${priceRaw}" is not a valid price.`);
      return;
    }
    if (sellingPriceMinor === 0n) {
      // Not refused: a distributor may genuinely carry a zero-priced item. But a catalogue full
      // of them is a column that did not import, and that is worth seeing before committing.
      add('selling_price', 'warning', 'The selling price is zero.');
    }

    const taxRaw = row.tax_rate_percent ?? '';
    const taxPercent = taxRaw ? Number(taxRaw.replace(/[, %]/g, '')) : 15;
    if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
      add('tax_rate_percent', 'error', `"${taxRaw}" is not a tax percentage between 0 and 100.`);
      return;
    }
    // Basis points, because a rate that multiplies money must itself be exact.
    const taxRateBp = Math.round(taxPercent * 100);

    const thresholdRaw = row.reorder_threshold ?? '';
    const reorderThreshold = thresholdRaw ? parseWholeNumber(thresholdRaw) : 0;
    if (reorderThreshold === null || reorderThreshold < 0) {
      add('reorder_threshold', 'error', `"${thresholdRaw}" is not a whole number of units.`);
      return;
    }

    rows.push({
      sku,
      name,
      category: row.category || null,
      unit,
      sellingPriceMinor,
      taxRateBp,
      reorderThreshold,
    });
    lineNumbers.push(line);
  });

  return { rows, issues, lineNumbers, fatal: null };
}

export function parseOpeningStock(input: string): ParsedImport<OpeningStockRow> {
  const parsed = parseCsv(input, OPENING_STOCK_HEADERS);
  if (!parsed.ok) return empty(parsed.error);

  const rows: OpeningStockRow[] = [];
  const issues: RowIssue[] = [];
  const lineNumbers: number[] = [];
  const seenSkus = new Map<string, number>();

  parsed.table.rows.forEach((row, index) => {
    const line = parsed.table.lineNumbers[index]!;
    const add = (column: string, severity: Severity, message: string) =>
      issues.push({ line, column, severity, message });

    const sku = (row.sku ?? '').toUpperCase();
    if (!sku) {
      add('sku', 'error', 'A SKU is required.');
      return;
    }

    const previous = seenSkus.get(sku);
    if (previous !== undefined) {
      // Two opening counts for one product would be added together, which is exactly the silent
      // doubling §38 is about — caught here at the row level as well as at the file level.
      add('sku', 'error', `Duplicate SKU; already counted on line ${previous}.`);
      return;
    }
    seenSkus.set(sku, line);

    const quantity = parseWholeNumber(row.quantity ?? '');
    if (quantity === null) {
      add('quantity', 'error', `"${row.quantity}" is not a whole number.`);
      return;
    }
    if (quantity < 0) {
      add('quantity', 'error', 'An opening count cannot be negative.');
      return;
    }

    rows.push({ sku, quantity });
    lineNumbers.push(line);
  });

  return { rows, issues, lineNumbers, fatal: null };
}

/**
 * A fingerprint of the file's content.
 *
 * §38: an operator must not be able to import the same opening-stock file twice and silently
 * double the yard. Content-based rather than filename-based, because "stock.csv" and
 * "stock (1).csv" are the same file and `opening-final-FINAL.csv` is a different one.
 *
 * Whitespace-normalised so that re-saving in Excel — which rewrites line endings and may add a
 * trailing newline — does not make an identical file look new.
 */
export function fileFingerprint(content: string): string {
  const normalised = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalised).digest('hex');
}

export function hasErrors(issues: readonly RowIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
