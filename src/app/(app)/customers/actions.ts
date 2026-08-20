'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actorFrom, requirePermission } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { createCustomer, updateCustomer } from '@/modules/customers';

export interface CustomerFormState {
  readonly error?: string;
  readonly field?: string;
}

function toInput(formData: FormData) {
  return {
    companyName: formData.get('companyName'),
    contactName: formData.get('contactName'),
    phone: formData.get('phone'),
    email: formData.get('email'),
    preferredLanguage: formData.get('preferredLanguage'),
    address: formData.get('address'),
    creditStatus: formData.get('creditStatus'),
    creditLimit: formData.get('creditLimit'),
    paymentTermsDays: formData.get('paymentTermsDays'),
    notes: formData.get('notes'),
  };
}

export async function createCustomerAction(
  _previous: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  // The permission is checked here, on the server, not only where the button was rendered.
  const session = await requirePermission('write:customer');

  const result = await withTenant(session.organizationId, (tx) =>
    createCustomer(tx, actorFrom(session), toInput(formData), session.currency),
  );

  if (!result.ok) {
    return { error: result.error.message, field: result.error.details?.field as string };
  }

  revalidatePath('/customers');
  redirect(`/customers/${result.value.id}`);
}

export async function updateCustomerAction(
  id: string,
  _previous: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const session = await requirePermission('write:customer');

  const result = await withTenant(session.organizationId, (tx) =>
    updateCustomer(tx, actorFrom(session), id, toInput(formData), session.currency),
  );

  if (!result.ok) {
    return { error: result.error.message, field: result.error.details?.field as string };
  }

  revalidatePath(`/customers/${id}`);
  revalidatePath('/customers');
  return {};
}
