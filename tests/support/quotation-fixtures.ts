import { withTenant } from '@/platform/db';
import { confirmItem, createInquiry, getInquiry, markReadyForQuote, runParse } from '@/modules/inquiries';
import { MockAIProvider } from '@/platform/ai/mock-provider';
import type { ActorContext } from '@/platform/context';
import { owner } from './fixtures';
import { seedCatalogue } from './catalogue';

/**
 * Gets an organization to the point where a quotation can be drafted.
 *
 * Deliberately goes through the real Phase 2 workflow — create, parse, confirm every line, mark
 * ready — rather than inserting a READY_FOR_QUOTE row directly. A quotation drafted from a
 * hand-built inquiry would not prove that the two phases actually join up.
 */
export async function readyInquiry(
  organizationId: string,
  context: ActorContext,
  options: {
    message?: string;
    companyName?: string;
    creditStatus?: 'CASH_ONLY' | 'CREDIT_ALLOWED' | 'SUSPENDED';
    paymentTermsDays?: number;
    seedProducts?: boolean;
  } = {},
): Promise<{ inquiryId: string; customerId: string }> {
  if (options.seedProducts !== false) await seedCatalogue(organizationId);

  const customer = await owner.customer.create({
    data: {
      organizationId,
      companyName: options.companyName ?? 'ABC Construction PLC',
      creditStatus: options.creditStatus ?? 'CREDIT_ALLOWED',
      paymentTermsDays: options.paymentTermsDays ?? 30,
      creditLimitMinor: 200_000_000n,
    },
  });

  const message =
    options.message ?? '500 bags OPC cement, 80 pcs 12mm rebar, 50 pcs 10mm. Please quote.';

  const created = await withTenant(organizationId, (tx) =>
    createInquiry(tx, context, { rawMessage: message, customerId: customer.id }),
  );
  if (!created.ok) throw new Error('inquiry creation failed in fixture');

  const parsed = await runParse(organizationId, context, created.value.id, new MockAIProvider());
  if (!parsed.ok) throw new Error('parse failed in fixture');

  const view = await withTenant(organizationId, (tx) => getInquiry(tx, created.value.id));
  if (!view.ok) throw new Error('inquiry not readable in fixture');

  await withTenant(organizationId, async (tx) => {
    for (const item of view.value.items) await confirmItem(tx, context, item.id);
  });

  const ready = await withTenant(organizationId, (tx) =>
    markReadyForQuote(tx, context, created.value.id),
  );
  if (!ready.ok) throw new Error(`inquiry did not reach ready: ${ready.error.message}`);

  return { inquiryId: created.value.id, customerId: customer.id };
}
