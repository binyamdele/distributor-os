'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote } from '@/components/ui';
import { t } from '@/platform/i18n';
import { type InquiryFormState, markReadyAction, parseInquiryAction } from '../actions';

function Pending({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

export function ParseButton({ inquiryId, again }: { inquiryId: string; again: boolean }) {
  const [state, formAction] = useActionState<InquiryFormState, FormData>(
    parseInquiryAction.bind(null, inquiryId),
    {},
  );

  return (
    <div className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <form action={formAction}>
        <Pending idle={t(again ? 'inquiry.reparse' : 'inquiry.parse')} busy={t('inquiry.parsing')} />
      </form>
    </div>
  );
}

export function MarkReadyButton({ inquiryId, disabled }: { inquiryId: string; disabled: boolean }) {
  const [state, formAction] = useActionState<InquiryFormState, FormData>(
    markReadyAction.bind(null, inquiryId),
    {},
  );

  return (
    <div className="space-y-2">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      <form action={formAction}>
        <Button type="submit" disabled={disabled}>
          {t('inquiry.markReady')}
        </Button>
      </form>
    </div>
  );
}
