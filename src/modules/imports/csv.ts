/**
 * A small, strict CSV reader.
 *
 * Not a dependency, because the requirement is narrow and the alternative is worse. A general
 * spreadsheet library would happily accept an arbitrary workbook — which is exactly what §34
 * says not to build. Explicit templates with known columns need a parser that handles quoting,
 * embedded commas, embedded newlines and a BOM, and that is a hundred lines.
 *
 * Deliberate limitations, all of them refusals rather than silent coercions:
 *
 *   - No type inference. Every cell comes out a trimmed string; the row schemas decide meaning.
 *   - No delimiter guessing. Comma only. A semicolon file fails loudly at the header check.
 *   - No header aliasing. `SKU` is not `sku_code`; a template is a template.
 *
 * The BOM matters more than it should: Excel writes one on every "CSV UTF-8" export, and without
 * stripping it the first header becomes `﻿sku` and every row reports a missing column.
 */

export interface CsvTable {
  readonly headers: readonly string[];
  /** One map per row, keyed by header. Every value trimmed. */
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** 1-based line number in the file, for error messages a person can act on. */
  readonly lineNumbers: readonly number[];
}

export type CsvResult =
  { readonly ok: true; readonly table: CsvTable } | { readonly ok: false; readonly error: string };

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote — the CSV escape.
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current);
  return cells;
}

/** Splits on newlines that are not inside quotes, so an address with a line break survives. */
function splitRecords(text: string): { line: string; number: number }[] {
  const records: { line: string; number: number }[] = [];
  let current = '';
  let quoted = false;
  let lineNumber = 1;
  let startedAt = 1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (char === '"') {
      // Track quote state so a newline inside a field does not end the record.
      const doubled = quoted && text[index + 1] === '"';
      if (doubled) {
        current += '""';
        index += 1;
        continue;
      }
      quoted = !quoted;
      current += char;
      continue;
    }

    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      records.push({ line: current, number: startedAt });
      lineNumber += 1;
      startedAt = lineNumber;
      current = '';
      continue;
    }

    if (char === '\n') lineNumber += 1;
    current += char;
  }

  if (current.length > 0) records.push({ line: current, number: startedAt });
  return records;
}

const MAX_ROWS = 20_000;

export function parseCsv(input: string, expectedHeaders: readonly string[]): CsvResult {
  // Excel's "CSV UTF-8" writes a BOM. Without stripping it the first header never matches.
  const text = input.replace(/^﻿/, '');

  const records = splitRecords(text).filter((record) => record.line.trim().length > 0);
  if (records.length === 0) return { ok: false, error: 'The file is empty.' };

  const headers = splitLine(records[0]!.line).map((cell) => cell.trim().toLowerCase());

  const missing = expectedHeaders.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `The file is missing required column(s): ${missing.join(', ')}.\n` +
        `Expected: ${expectedHeaders.join(', ')}\n` +
        `Found: ${headers.join(', ') || '(none)'}`,
    };
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_ROWS) {
    return {
      ok: false,
      error: `The file has ${dataRecords.length} rows; the limit is ${MAX_ROWS}. Split it.`,
    };
  }

  const rows: Record<string, string>[] = [];
  const lineNumbers: number[] = [];

  for (const record of dataRecords) {
    const cells = splitLine(record.line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? '').trim();
    });
    rows.push(row);
    lineNumbers.push(record.number);
  }

  return { ok: true, table: { headers, rows, lineNumbers } };
}
