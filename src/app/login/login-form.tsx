'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { t } from '@/platform/i18n';
import { type LoginState, signIn } from './actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? t('auth.signingIn') : t('auth.signIn')}
    </Button>
  );
}

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(signIn, {});

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <Field label={t('auth.email')}>
        <Input name="email" type="email" autoComplete="username" required autoFocus />
      </Field>

      <Field label={t('auth.password')}>
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>

      <SubmitButton />
    </form>
  );
}
