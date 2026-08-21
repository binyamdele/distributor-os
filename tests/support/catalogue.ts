import { normalizeAlias } from '@/modules/catalog/normalize';
import { owner } from './fixtures';

/**
 * The demo catalogue, planted into a test organization.
 *
 * The same products and aliases the seed uses, so the matching tests exercise the corpus a
 * pilot user would actually meet rather than a convenient fiction shaped to pass.
 */
export const DEMO_CATALOGUE: {
  sku: string;
  name: string;
  unit: string;
  priceMinor: bigint;
  stock: number;
  aliases: string[];
}[] = [
  {
    sku: 'CEM-OPC-50',
    name: 'OPC Cement 50kg',
    unit: 'bag',
    priceMinor: 125_000n,
    stock: 4_800,
    aliases: ['OPC cement', 'cement', 'OPC', 'ordinary portland cement', '50kg cement', 'ስሚንቶ'],
  },
  {
    sku: 'RB-08',
    name: 'Rebar 8mm',
    unit: 'piece',
    priceMinor: 64_000n,
    stock: 1_900,
    aliases: ['8mm', '8 mm', '8mm rebar', '8 fer', 'rebar 8'],
  },
  {
    sku: 'RB-10',
    name: 'Rebar 10mm',
    unit: 'piece',
    priceMinor: 98_500n,
    stock: 2_400,
    aliases: ['10mm', '10 mm', '10mm rebar', '10 fer', 'rebar 10'],
  },
  {
    sku: 'RB-12',
    name: 'Rebar 12mm',
    unit: 'piece',
    priceMinor: 142_000n,
    stock: 620,
    aliases: ['12mm', '12 mm', '12mm rebar', '12 mm steel', '12 fer', 'rebar 12'],
  },
  {
    sku: 'RB-16',
    name: 'Rebar 16mm',
    unit: 'piece',
    priceMinor: 251_000n,
    stock: 240,
    aliases: ['16mm', '16 mm', '16mm rebar', '16 fer', 'rebar 16'],
  },
  {
    sku: 'HB-20',
    name: 'Hollow Block 20cm',
    unit: 'piece',
    priceMinor: 4_200n,
    stock: 15_000,
    aliases: ['hollow block', 'HCB', '20cm block', 'block 20'],
  },
];

export async function seedCatalogue(organizationId: string): Promise<void> {
  // Several listed spellings normalise to the same alias — "8 mm" and "8mm" are one entry once
  // normalised — and the unique index is per organization. The real seed upserts; here the
  // duplicates are skipped, which keeps the resulting corpus identical either way.
  const seen = new Set<string>();

  for (const product of DEMO_CATALOGUE) {
    const created = await owner.product.create({
      data: {
        organizationId,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        sellingPriceMinor: product.priceMinor,
        availableStock: product.stock,
        reorderThreshold: 0,
      },
    });

    for (const alias of product.aliases) {
      const normalizedAlias = normalizeAlias(alias);
      if (seen.has(normalizedAlias)) continue;
      seen.add(normalizedAlias);

      await owner.productAlias.create({
        data: {
          organizationId,
          productId: created.id,
          alias,
          normalizedAlias,
          source: 'SEED',
        },
      });
    }
  }
}
