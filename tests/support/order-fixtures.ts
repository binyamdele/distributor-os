import { withTenant } from '@/platform/db';
import {
  approve,
  createFromInquiry,
  markSent,
  recordAcceptance,
  submitForApproval,
} from '@/modules/quotations';
import type { ActorContext } from '@/platform/context';
import { owner } from './fixtures';
import { readyInquiry } from './quotation-fixtures';

/**
 * Walks a quotation through the whole Phase 2 and Phase 3 workflow to reach SENT.
 *
 * Deliberately goes through the real functions rather than inserting a SENT row: a Phase 4 test
 * built on a hand-made quotation would not prove that the phases join up, and the follow-up that
 * `markSent` schedules is precisely what several of these tests are about.
 */
export async function sentQuotation(
  organizationId: string,
  context: ActorContext,
  options: {
    message?: string;
    companyName?: string;
    paymentType?: 'CASH' | 'CREDIT';
    paymentTermsDays?: number;
    creditStatus?: 'CASH_ONLY' | 'CREDIT_ALLOWED' | 'SUSPENDED';
    seedProducts?: boolean;
    /** Stop early, to test a transition that should be refused. */
    stopAt?: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENT';
    accept?: boolean;
    /**
     * Backdate the validity, *before* approval.
     *
     * It has to be set before the quotation is approved, because the validity date is part of
     * the approval payload. Changing it afterwards invalidates the approval, and an acceptance
     * attempt would then refuse for that reason rather than for expiry — which is correct
     * behaviour, and would make an expiry test quietly assert the wrong invariant.
     */
    validityDate?: Date;
  } = {},
): Promise<{ quotationId: string; quotationNumber: string; customerId: string }> {
  const { inquiryId, customerId } = await readyInquiry(organizationId, context, {
    message: options.message,
    companyName: options.companyName,
    creditStatus: options.creditStatus ?? 'CREDIT_ALLOWED',
    paymentTermsDays: options.paymentTermsDays ?? 30,
    seedProducts: options.seedProducts,
  });

  // The demo customer's address, so the delivery snapshot has something real to copy.
  await owner.customer.update({
    where: { id: customerId },
    data: { address: 'Bole Bulbula, Addis Ababa' },
  });

  const drafted = await withTenant(organizationId, (tx) =>
    createFromInquiry(tx, context, {
      inquiryId,
      paymentType: options.paymentType ?? 'CASH',
      paymentTermsDays: options.paymentTermsDays ?? 0,
    }),
  );
  if (!drafted.ok) throw new Error(`draft failed: ${drafted.error.message}`);
  // Applied while the quotation is still a draft, so the approval that follows covers this
  // exact payload — including the date.
  if (options.validityDate) {
    await owner.quotation.update({
      where: { id: drafted.value.id },
      data: { validityDate: options.validityDate },
    });
  }

  const stopAt = options.stopAt ?? 'SENT';
  if (stopAt === 'DRAFT') {
    return { ...drafted.value, quotationId: drafted.value.id, customerId };
  }

  const submitted = await withTenant(organizationId, (tx) =>
    submitForApproval(tx, context, drafted.value.id),
  );
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.error.message}`);
  if (stopAt === 'PENDING_APPROVAL') {
    return { ...drafted.value, quotationId: drafted.value.id, customerId };
  }

  const approved = await withTenant(organizationId, (tx) => approve(tx, context, drafted.value.id));
  if (!approved.ok) throw new Error(`approve failed: ${approved.error.message}`);
  if (stopAt === 'APPROVED') {
    return { ...drafted.value, quotationId: drafted.value.id, customerId };
  }

  const sent = await withTenant(organizationId, (tx) => markSent(tx, context, drafted.value.id));
  if (!sent.ok) throw new Error(`send failed: ${sent.error.message}`);

  if (options.accept) {
    const accepted = await withTenant(organizationId, (tx) =>
      recordAcceptance(tx, context, drafted.value.id, { source: 'PHONE' }),
    );
    if (!accepted.ok) throw new Error(`accept failed: ${accepted.error.message}`);
  }

  return {
    quotationId: drafted.value.id,
    quotationNumber: drafted.value.quotationNumber,
    customerId,
  };
}
