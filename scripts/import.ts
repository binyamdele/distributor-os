/**
 * Imports a distributor's customers, products or opening stock from a CSV file.
 *
 * Two steps, always, and the first one writes nothing:
 *
 *   pnpm admin:import --org <id> --kind products --file ./products.csv
 *   pnpm admin:import --org <id> --kind products --file ./products.csv --commit
 *
 * Running without `--commit` prints exactly what would happen — how many rows would be created,
 * how many would update something that already exists, and every error and warning with its line
 * number. An import that writes on the first invocation is one where the first time anyone reads
 * the errors is after they are in the database.
 *
 * A CLI rather than a screen, deliberately. This runs once per distributor, during onboarding,
 * by whoever is setting the system up — not by a salesperson on a Tuesday. Building an upload UI
 * for it would be a week of work to make a one-time operation slightly more comfortable, and
 * would put a file-upload path in front of every user for no ongoing benefit.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { withTenant } from '../src/platform/db';
import {
  commitCustomers,
  commitOpeningStock,
  commitProducts,
  previewCustomers,
  previewOpeningStock,
  previewProducts,
} from '../src/modules/imports';
import type { RowIssue } from '../src/modules/imports';

loadEnv();

type Kind = 'customers' | 'products' | 'opening-stock';

interface Args {
  org?: string;
  kind?: Kind;
  file?: string;
  commit: boolean;
  acknowledgeDuplicate: boolean;
  actor?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { commit: false, acknowledgeDuplicate: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === '--commit') args.commit = true;
    else if (flag === '--acknowledge-duplicate') args.acknowledgeDuplicate = true;
    else if (flag === '--org' && value) args.org = value;
    else if (flag === '--kind' && value) args.kind = value as Kind;
    else if (flag === '--file' && value) args.file = value;
    else if (flag === '--actor' && value) args.actor = value;
  }

  return args;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function printIssues(issues: readonly RowIssue[]): void {
  if (issues.length === 0) return;

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  if (errors.length > 0) {
    console.log(`\n  ${errors.length} error(s) — nothing will be imported until these are fixed:`);
    // Capped, because a badly-exported file can produce thousands and the operator only needs
    // enough to see the pattern.
    for (const issue of errors.slice(0, 40)) {
      console.log(`    line ${issue.line}, ${issue.column}: ${issue.message}`);
    }
    if (errors.length > 40) console.log(`    … and ${errors.length - 40} more`);
  }

  if (warnings.length > 0) {
    console.log(`\n  ${warnings.length} warning(s) — these will be imported as they are:`);
    for (const issue of warnings.slice(0, 20)) {
      console.log(`    line ${issue.line}, ${issue.column}: ${issue.message}`);
    }
    if (warnings.length > 20) console.log(`    … and ${warnings.length - 20} more`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.org || !args.kind || !args.file) {
    fail(
      'Usage:\n' +
        '  pnpm admin:import --org <organization-id> --kind <customers|products|opening-stock> \\\n' +
        '                    --file ./path.csv [--commit]\n\n' +
        'Without --commit nothing is written; you get a preview of exactly what would happen.\n\n' +
        'Templates are in docs/import-templates/. Import in this order: products, then opening\n' +
        'stock (which needs the products to exist), then customers.',
    );
  }

  if (!['customers', 'products', 'opening-stock'].includes(args.kind)) {
    fail(`"${args.kind}" is not a kind. Use customers, products or opening-stock.`);
  }

  let content: string;
  try {
    content = readFileSync(args.file, 'utf8');
  } catch {
    fail(`Could not read "${args.file}".`);
  }

  const filename = basename(args.file);
  const context = {
    organizationId: args.org,
    userId: args.actor ?? null,
    role: 'OWNER_ADMIN' as const,
    source: 'system' as const,
  };

  console.log(`\n${args.commit ? 'Importing' : 'Previewing'} ${args.kind} from ${filename}…`);

  await withTenant(args.org, async (tx) => {
    if (args.kind === 'customers') {
      const preview = await previewCustomers(tx, content);
      if (!preview.ok) fail(preview.error.message);

      console.log(`\n  ${preview.value.rows.length} row(s) read`);
      console.log(`  ${preview.value.toCreate} would be created`);
      console.log(`  ${preview.value.toUpdate} would update an existing customer`);
      printIssues(preview.value.issues);

      if (preview.value.alreadyImportedAt) {
        console.log(
          `\n  This exact file was already imported on ${preview.value.alreadyImportedAt.toISOString().slice(0, 10)}.`,
        );
      }

      if (!args.commit) {
        console.log('\n  Nothing was written. Add --commit to import.\n');
        return;
      }

      const result = await commitCustomers(tx, context, content, {
        filename,
        acknowledgeDuplicate: args.acknowledgeDuplicate,
      });
      if (!result.ok) fail(result.error.message);
      console.log(`\n  Imported: ${result.value.created} created, ${result.value.updated} updated.\n`);
      return;
    }

    if (args.kind === 'products') {
      const preview = await previewProducts(tx, content);
      if (!preview.ok) fail(preview.error.message);

      console.log(`\n  ${preview.value.rows.length} row(s) read`);
      console.log(`  ${preview.value.toCreate} would be created`);
      console.log(`  ${preview.value.toUpdate} would update an existing product`);
      printIssues(preview.value.issues);

      if (preview.value.alreadyImportedAt) {
        console.log(
          `\n  This exact file was already imported on ${preview.value.alreadyImportedAt.toISOString().slice(0, 10)}.`,
        );
      }

      if (!args.commit) {
        console.log('\n  Nothing was written. Add --commit to import.\n');
        return;
      }

      const result = await commitProducts(tx, context, content, {
        filename,
        acknowledgeDuplicate: args.acknowledgeDuplicate,
      });
      if (!result.ok) fail(result.error.message);
      console.log(`\n  Imported: ${result.value.created} created, ${result.value.updated} updated.`);
      console.log('  Stock is untouched — import opening stock separately.\n');
      return;
    }

    const preview = await previewOpeningStock(tx, content);
    if (!preview.ok) fail(preview.error.message);

    const totalUnits = preview.value.rows.reduce((sum, row) => sum + row.quantity, 0);
    console.log(`\n  ${preview.value.rows.length} product(s), ${totalUnits.toLocaleString()} units`);
    printIssues(preview.value.issues);

    if (preview.value.alreadyImportedAt) {
      console.log(
        `\n  This exact file was already imported on ${preview.value.alreadyImportedAt.toISOString().slice(0, 10)}.` +
          '\n  Importing it again is refused: it would double the counts.',
      );
    }

    if (!args.commit) {
      console.log('\n  Nothing was written. Add --commit to import.\n');
      return;
    }

    const result = await commitOpeningStock(tx, context, content, { filename });
    if (!result.ok) fail(result.error.message);
    console.log(`\n  Opening balance set for ${result.value.created} product(s).`);
    console.log('  Each one is recorded in the inventory ledger as an OPENING_BALANCE movement.\n');
  });
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
