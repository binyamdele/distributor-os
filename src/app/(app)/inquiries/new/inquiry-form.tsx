'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Button, ErrorNote, Field, Select, Textarea } from '@/components/ui';
import { t } from '@/platform/i18n';
import { type InquiryFormState, createInquiryAction } from '../actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {t('action.create')}
    </Button>
  );
}

/**
 * Channels other than MANUAL are selectable so the domain seam is visible, but nothing sends or
 * receives on them in this phase — picking one records where the message came from and no more.
 */
const CHANNELS = [
  { value: 'MANUAL', label: 'Manual entry' },
  { value: 'WHATSAPP', label: 'WhatsApp (recorded by hand)' },
  { value: 'TELEGRAM', label: 'Telegram (recorded by hand)' },
  { value: 'EMAIL', label: 'Email (recorded by hand)' },
  { value: 'SMS', label: 'SMS (recorded by hand)' },
  { value: 'PHONE_NOTE', label: 'Phone note' },
];

export function InquiryForm({
  customers,
}: {
  customers: { id: string; companyName: string }[];
}) {
  const [state, formAction] = useActionState<InquiryFormState, FormData>(createInquiryAction, {});

  return (
    <form action={formAction} className="space-y-5">
      {state.error && !state.field ? <ErrorNote>{state.error}</ErrorNote> : null}

      <Field
        label={t('inquiry.rawMessage')}
        hint={t('inquiry.rawMessageHint')}
        error={state.field === 'rawMessage' ? state.error : undefined}
      >
        <Textarea
          name="rawMessage"
          rows={6}
          required
          maxLength={8000}
          placeholder="Selam, 500 bags OPC cement, 80 pcs 12mm rebar…"
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t('inquiry.channel')}>
          <Select name="channel" defaultValue="MANUAL">
            {CHANNELS.map((channel) => (
              <option key={channel.value} value={channel.value}>
                {channel.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('inquiry.customerOptional')}>
          <Select name="customerId" defaultValue="">
            <option value="">{t('inquiry.customerUnknown')}</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.companyName}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Submit />
        <Link href="/inquiries" className="text-sm text-ink-muted hover:text-ink">
          {t('action.cancel')}
        </Link>
      </div>
    </form>
  );
}
