import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/modules/imports/csv';
import {
  ALLOWED_UNITS,
  fileFingerprint,
  hasErrors,
  parseCustomers,
  parseMoneyToMinor,
  parseOpeningStock,
  parseProducts,
  parseWholeNumber,
} from '@/modules/imports/templates';

/**
 * The import rules.
 *
 * These decide what a distributor's catalogue becomes on day one, so a wrong answer here is not
 * a bug that surfaces later — it is a wrong price on every quotation from then on. Everything is
 * pure, so every rule is enumerable without a database.
 */

const productHeader = 'sku,name,category,unit,selling_price,tax_rate_percent,reorder_threshold';
const customerHeader =
  'company_name,contact_name,phone,email,address,credit_status,credit_limit,payment_terms_days';

describe('the CSV reader', () => {
  it('reads a plain file', () => {
    const result = parseCsv('a,b\n1,2\n3,4', ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('strips the byte-order mark Excel writes', () => {
    // Without this, the first header becomes "﻿a" and every row reports a missing column —
    // on a file that looks completely normal in a text editor.
    const result = parseCsv('﻿a,b\n1,2', ['a', 'b']);
    expect(result.ok).toBe(true);
  });

  it('keeps a comma inside a quoted field', () => {
    const result = parseCsv('a,b\n"Bole Bulbula, Addis Ababa",2', ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows[0]!.a).toBe('Bole Bulbula, Addis Ababa');
  });

  it('keeps a newline inside a quoted field', () => {
    const result = parseCsv('a,b\n"line one\nline two",2', ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows).toHaveLength(1);
    expect(result.table.rows[0]!.a).toBe('line one\nline two');
  });

  it('unescapes a doubled quote', () => {
    const result = parseCsv('a,b\n"He said ""yes""",2', ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows[0]!.a).toBe('He said "yes"');
  });

  it('handles CRLF line endings', () => {
    const result = parseCsv('a,b\r\n1,2\r\n3,4', ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.rows).toHaveLength(2);
  });

  it('reports missing columns by name', () => {
    const result = parseCsv('sku,name\nA,B', ['sku', 'name', 'unit']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unit');
  });

  it('refuses a semicolon-delimited file rather than guessing', () => {
    // Guessing the delimiter is how a European export silently becomes one column.
    const result = parseCsv('sku;name\nA;B', ['sku', 'name']);
    expect(result.ok).toBe(false);
  });

  it('refuses an empty file', () => {
    expect(parseCsv('', ['a']).ok).toBe(false);
  });

  it('reports line numbers a person can find in their spreadsheet', () => {
    const result = parseCsv('a\n1\n2\n3', ['a']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.lineNumbers).toEqual([2, 3, 4]);
  });
});

describe('money parsing', () => {
  it('never uses floating point', () => {
    // parseFloat('1250.10') * 100 is 125009.99999999999. A catalogue imported that way is wrong
    // by a santim on entry, and it propagates into every quotation total afterwards.
    expect(parseMoneyToMinor('1250.10')).toBe(125_010n);
    expect(parseMoneyToMinor('0.07')).toBe(7n);
    expect(parseMoneyToMinor('1250.1')).toBe(125_010n);
  });

  it('accepts thousands separators, because spreadsheets write them', () => {
    expect(parseMoneyToMinor('2,000,000.00')).toBe(200_000_000n);
  });

  it('accepts a whole number', () => {
    expect(parseMoneyToMinor('1250')).toBe(125_000n);
  });

  it('refuses more than two decimal places rather than rounding silently', () => {
    expect(parseMoneyToMinor('1250.123')).toBeNull();
  });

  it('refuses a negative, a currency symbol and prose', () => {
    for (const input of ['-5.00', 'ETB 1250', '1 250,00', 'free', '']) {
      expect(parseMoneyToMinor(input), input).toBeNull();
    }
  });

  it('parses whole numbers and refuses fractions', () => {
    expect(parseWholeNumber('4,800')).toBe(4800);
    expect(parseWholeNumber('0')).toBe(0);
    expect(parseWholeNumber('12.5')).toBeNull();
    expect(parseWholeNumber('many')).toBeNull();
  });
});

describe('the products template', () => {
  const file = (rows: string) => `${productHeader}\n${rows}`;

  it('reads a valid catalogue', () => {
    const parsed = parseProducts(
      file(
        'CEM-OPC-50,OPC Cement 50kg,Cement,bag,1250.00,15,1000\nRB-12,Rebar 12mm,,piece,1420,15,600',
      ),
    );

    expect(parsed.fatal).toBeNull();
    expect(hasErrors(parsed.issues)).toBe(false);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      sku: 'CEM-OPC-50',
      unit: 'bag',
      sellingPriceMinor: 125_000n,
      taxRateBp: 1500,
      reorderThreshold: 1000,
    });
    // Category is genuinely optional.
    expect(parsed.rows[1]!.category).toBeNull();
  });

  it('upper-cases the SKU, so case is never the difference between two products', () => {
    const parsed = parseProducts(file('cem-opc-50,Cement,,bag,1250,15,0'));
    expect(parsed.rows[0]!.sku).toBe('CEM-OPC-50');
  });

  it('refuses a duplicate SKU and names the line it clashes with', () => {
    const parsed = parseProducts(
      file('CEM-OPC-50,Cement,,bag,1250,15,0\nCEM-OPC-50,Cement again,,bag,1300,15,0'),
    );

    expect(hasErrors(parsed.issues)).toBe(true);
    const issue = parsed.issues.find((entry) => entry.column === 'sku');
    expect(issue!.message).toContain('line 2');
    // The duplicate is not imported.
    expect(parsed.rows).toHaveLength(1);
  });

  it('refuses a duplicate SKU that differs only in case', () => {
    const parsed = parseProducts(
      file('CEM-50,Cement,,bag,1250,15,0\ncem-50,Cement,,bag,1250,15,0'),
    );
    expect(hasErrors(parsed.issues)).toBe(true);
  });

  it('refuses an unknown unit rather than accepting free text', () => {
    // "bag", "Bags", "BAG" and "bg" in one catalogue makes every quantity on every quotation
    // ambiguous, and by the time anyone notices it is in six months of orders.
    const parsed = parseProducts(file('X-1,Thing,,sackful,10,15,0'));
    expect(hasErrors(parsed.issues)).toBe(true);
    expect(parsed.issues[0]!.message).toContain('sackful');
    expect(parsed.issues[0]!.message).toContain('bag');
  });

  it('accepts every documented unit', () => {
    for (const unit of ALLOWED_UNITS) {
      const parsed = parseProducts(file(`X-1,Thing,,${unit},10,15,0`));
      expect(hasErrors(parsed.issues), unit).toBe(false);
    }
  });

  it('normalises unit case', () => {
    expect(parseProducts(file('X-1,Thing,,BAG,10,15,0')).rows[0]!.unit).toBe('bag');
  });

  it('refuses an invalid price', () => {
    const parsed = parseProducts(file('X-1,Thing,,bag,about 1250,15,0'));
    expect(hasErrors(parsed.issues)).toBe(true);
    expect(parsed.issues[0]!.column).toBe('selling_price');
  });

  it('warns about a zero price without refusing it', () => {
    // A distributor may genuinely carry one. A catalogue full of them is a column that did not
    // import, and that is worth seeing before committing rather than after.
    const parsed = parseProducts(file('X-1,Thing,,bag,0,15,0'));
    expect(hasErrors(parsed.issues)).toBe(false);
    expect(parsed.issues[0]!.severity).toBe('warning');
    expect(parsed.rows).toHaveLength(1);
  });

  it('converts the tax rate to basis points', () => {
    expect(parseProducts(file('X-1,Thing,,bag,10,15,0')).rows[0]!.taxRateBp).toBe(1500);
    expect(parseProducts(file('X-1,Thing,,bag,10,7.5,0')).rows[0]!.taxRateBp).toBe(750);
    expect(parseProducts(file('X-1,Thing,,bag,10,0,0')).rows[0]!.taxRateBp).toBe(0);
  });

  it('refuses a tax rate outside 0 to 100', () => {
    expect(hasErrors(parseProducts(file('X-1,Thing,,bag,10,150,0')).issues)).toBe(true);
  });

  it('refuses a SKU with characters that would break a URL or a filename', () => {
    expect(hasErrors(parseProducts(file('X 1/2,Thing,,bag,10,15,0')).issues)).toBe(true);
  });

  it('refuses a missing name', () => {
    expect(hasErrors(parseProducts(file('X-1,,,bag,10,15,0')).issues)).toBe(true);
  });
});

describe('the customers template', () => {
  const file = (rows: string) => `${customerHeader}\n${rows}`;

  it('reads a valid customer list', () => {
    const parsed = parseCustomers(
      file(
        'ABC Construction PLC,Tewodros,+251911000101,a@b.example,Bole,CREDIT_ALLOWED,2000000.00,30',
      ),
    );

    expect(hasErrors(parsed.issues)).toBe(false);
    expect(parsed.rows[0]).toMatchObject({
      companyName: 'ABC Construction PLC',
      creditStatus: 'CREDIT_ALLOWED',
      creditLimitMinor: 200_000_000n,
      paymentTermsDays: 30,
    });
  });

  it('defaults an empty credit status to cash only', () => {
    // The safe direction. Defaulting to credit would extend terms nobody agreed to.
    const parsed = parseCustomers(file('Someone,,,,,,,'));
    expect(parsed.rows[0]!.creditStatus).toBe('CASH_ONLY');
  });

  it('refuses an unrecognised credit status', () => {
    const parsed = parseCustomers(file('Someone,,,,,MAYBE,0,0'));
    expect(hasErrors(parsed.issues)).toBe(true);
    expect(parsed.issues[0]!.message).toContain('CASH_ONLY');
  });

  it('refuses a duplicate company name, case-insensitively', () => {
    // Two spellings of one customer becomes two ledgers for one debtor.
    const parsed = parseCustomers(file('ABC Construction,,,,,,,\nabc construction,,,,,,,'));
    expect(hasErrors(parsed.issues)).toBe(true);
    expect(parsed.rows).toHaveLength(1);
  });

  it('warns when credit is allowed with no limit', () => {
    const parsed = parseCustomers(file('Someone,,,,,CREDIT_ALLOWED,0,30'));
    expect(hasErrors(parsed.issues)).toBe(false);
    expect(parsed.issues.some((issue) => issue.column === 'credit_limit')).toBe(true);
  });

  it('warns about an implausible phone without refusing the row', () => {
    // Advisory on purpose: phone formats vary, and refusing a customer because their number
    // has an extension would be worse than importing it.
    const parsed = parseCustomers(file('Someone,,not-a-number,,,,,'));
    expect(hasErrors(parsed.issues)).toBe(false);
    expect(parsed.issues[0]!.severity).toBe('warning');
    expect(parsed.rows).toHaveLength(1);
  });

  it('accepts Ethiopian mobile formats without warning', () => {
    for (const phone of ['+251911000101', '0911000101', '+251 91 100 0101']) {
      const parsed = parseCustomers(file(`Someone,,${phone},,,,,`));
      expect(parsed.issues, phone).toHaveLength(0);
    }
  });

  it('refuses a missing company name', () => {
    expect(hasErrors(parseCustomers(file(',Tewodros,,,,,,')).issues)).toBe(true);
  });

  it('refuses payment terms outside a plausible range', () => {
    expect(hasErrors(parseCustomers(file('Someone,,,,,,0,400')).issues)).toBe(true);
  });
});

describe('the opening stock template', () => {
  const file = (rows: string) => `sku,quantity\n${rows}`;

  it('reads a stock count', () => {
    const parsed = parseOpeningStock(file('CEM-OPC-50,4800\nRB-12,620'));
    expect(hasErrors(parsed.issues)).toBe(false);
    expect(parsed.rows).toEqual([
      { sku: 'CEM-OPC-50', quantity: 4800 },
      { sku: 'RB-12', quantity: 620 },
    ]);
  });

  it('accepts zero, which is a real count', () => {
    const parsed = parseOpeningStock(file('X-1,0'));
    expect(hasErrors(parsed.issues)).toBe(false);
    expect(parsed.rows[0]!.quantity).toBe(0);
  });

  it('refuses a negative count', () => {
    expect(hasErrors(parseOpeningStock(file('X-1,-5')).issues)).toBe(true);
  });

  it('refuses a fractional count', () => {
    expect(hasErrors(parseOpeningStock(file('X-1,4.5')).issues)).toBe(true);
  });

  it('refuses the same SKU twice', () => {
    // Two opening counts for one product would be summed, which is the silent doubling the
    // whole idempotency design exists to prevent — caught at the row level as well.
    const parsed = parseOpeningStock(file('X-1,100\nX-1,200'));
    expect(hasErrors(parsed.issues)).toBe(true);
    expect(parsed.rows).toHaveLength(1);
  });
});

describe('the file fingerprint', () => {
  const content = 'sku,quantity\nX-1,100\n';

  it('is identical for identical content', () => {
    expect(fileFingerprint(content)).toBe(fileFingerprint(content));
  });

  it('ignores a re-save that only changed line endings', () => {
    // Excel rewrites CRLF and may add a trailing newline. Without normalisation, re-saving the
    // same file would make it look new and the duplicate check would let it through.
    expect(fileFingerprint('sku,quantity\r\nX-1,100\r\n')).toBe(fileFingerprint(content));
  });

  it('ignores a byte-order mark', () => {
    expect(fileFingerprint(`﻿${content}`)).toBe(fileFingerprint(content));
  });

  it('changes when a single digit changes', () => {
    expect(fileFingerprint('sku,quantity\nX-1,101\n')).not.toBe(fileFingerprint(content));
  });

  it('is a sha-256 hex digest', () => {
    expect(fileFingerprint(content)).toMatch(/^[0-9a-f]{64}$/);
  });
});
