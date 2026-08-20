import 'server-only';
import { z } from 'zod';
import type { TenantTransaction } from '@/platform/db';
import type { ActorContext } from '@/platform/context';
import { type Result, fail, ok } from '@/platform/result';
import { parseDecimal, toDecimalString } from '@/platform/money';
import { recordAudit } from '@/modules/audit';

export const CREDIT_STATUSES = ['CASH_ONLY', 'CREDIT_ALLOWED', 'SUSPENDED'] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

/**
 * Customer input.
 *
 * The credit limit arrives as a decimal string typed by a human ("340000.00") and is converted
 * to minor units by the money module, which refuses excess precision. It never becomes a JS
 * number on the way through.
 */
export const customerInputSchema = z.object({
  companyName: z.string().trim().min(1, 'error.required').max(200),
  contactName: z.string().trim().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  preferredLanguage: z.enum(['en', 'am']).default('en'),
  address: z.string().trim().max(500).optional().or(z.literal('')),
  creditStatus: z.enum(CREDIT_STATUSES).default('CASH_ONLY'),
  creditLimit: z.string().trim().default('0'),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(0),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export type CustomerInput = z.infer<typeof customerInputSchema>;

export interface CustomerRecord {
  readonly id: string;
  readonly companyName: string;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly preferredLanguage: string;
  readonly address: string | null;
  readonly creditStatus: CreditStatus;
  readonly creditLimitMinor: bigint;
  readonly paymentTermsDays: number;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function listCustomers(
  tx: TenantTransaction,
  options: { search?: string } = {},
): Promise<CustomerRecord[]> {
  const search = options.search?.trim();
  return tx.customer.findMany({
    where: search
      ? {
          OR: [
            { companyName: { contains: search, mode: 'insensitive' } },
            { contactName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
          ],
        }
      : undefined,
    orderBy: { companyName: 'asc' },
    take: 200,
  }) as unknown as Promise<CustomerRecord[]>;
}

export async function getCustomer(
  tx: TenantTransaction,
  id: string,
): Promise<Result<CustomerRecord>> {
  const found = await tx.customer.findFirst({ where: { id } });
  if (!found) return fail('NOT_FOUND', 'error.notFound');
  return ok(found as unknown as CustomerRecord);
}

export async function createCustomer(
  tx: TenantTransaction,
  context: ActorContext,
  raw: unknown,
  currency: string,
): Promise<Result<CustomerRecord>> {
  const parsed = customerInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'error.generic', {
      field: parsed.error.issues[0]?.path.join('.'),
    });
  }
  const input = parsed.data;

  const creditLimit = parseDecimal(input.creditLimit || '0', currency);
  if (!creditLimit.ok) return creditLimit;

  // A credit limit on a cash-only customer is a contradiction that will later be read as
  // permission by whoever looks at the record. Refuse it here rather than store it.
  if (input.creditStatus === 'CASH_ONLY' && creditLimit.value.amountMinor > 0n) {
    return fail(
      'VALIDATION_FAILED',
      'A cash-only customer cannot carry a credit limit. Change the credit status or clear the limit.',
      { field: 'creditLimit' },
    );
  }

  const created = await tx.customer.create({
    data: {
      organizationId: context.organizationId,
      companyName: input.companyName,
      contactName: emptyToNull(input.contactName),
      phone: emptyToNull(input.phone),
      email: emptyToNull(input.email),
      preferredLanguage: input.preferredLanguage,
      address: emptyToNull(input.address),
      creditStatus: input.creditStatus,
      creditLimitMinor: creditLimit.value.amountMinor,
      paymentTermsDays: input.paymentTermsDays,
      notes: emptyToNull(input.notes),
    },
  });

  await recordAudit(tx, context, {
    action: 'customer.created',
    entityType: 'customer',
    entityId: created.id,
    newState: {
      companyName: created.companyName,
      creditStatus: created.creditStatus,
      creditLimit: toDecimalString({ amountMinor: created.creditLimitMinor, currency }),
      paymentTermsDays: created.paymentTermsDays,
    },
  });

  return ok(created as unknown as CustomerRecord);
}

export async function updateCustomer(
  tx: TenantTransaction,
  context: ActorContext,
  id: string,
  raw: unknown,
  currency: string,
): Promise<Result<CustomerRecord>> {
  const existing = await getCustomer(tx, id);
  if (!existing.ok) return existing;

  const parsed = customerInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'error.generic', {
      field: parsed.error.issues[0]?.path.join('.'),
    });
  }
  const input = parsed.data;

  const creditLimit = parseDecimal(input.creditLimit || '0', currency);
  if (!creditLimit.ok) return creditLimit;

  if (input.creditStatus === 'CASH_ONLY' && creditLimit.value.amountMinor > 0n) {
    return fail(
      'VALIDATION_FAILED',
      'A cash-only customer cannot carry a credit limit. Change the credit status or clear the limit.',
      { field: 'creditLimit' },
    );
  }

  const before = existing.value;
  const updated = await tx.customer.update({
    where: { id },
    data: {
      companyName: input.companyName,
      contactName: emptyToNull(input.contactName),
      phone: emptyToNull(input.phone),
      email: emptyToNull(input.email),
      preferredLanguage: input.preferredLanguage,
      address: emptyToNull(input.address),
      creditStatus: input.creditStatus,
      creditLimitMinor: creditLimit.value.amountMinor,
      paymentTermsDays: input.paymentTermsDays,
      notes: emptyToNull(input.notes),
    },
  });

  await recordAudit(tx, context, {
    action: 'customer.updated',
    entityType: 'customer',
    entityId: id,
    oldState: {
      companyName: before.companyName,
      creditStatus: before.creditStatus,
      creditLimit: toDecimalString({ amountMinor: before.creditLimitMinor, currency }),
      paymentTermsDays: before.paymentTermsDays,
    },
    newState: {
      companyName: updated.companyName,
      creditStatus: updated.creditStatus,
      creditLimit: toDecimalString({ amountMinor: updated.creditLimitMinor, currency }),
      paymentTermsDays: updated.paymentTermsDays,
    },
  });

  return ok(updated as unknown as CustomerRecord);
}
