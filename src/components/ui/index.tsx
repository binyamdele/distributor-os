import type { ComponentProps, ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: Parameters<typeof clsx>): string {
  return twMerge(clsx(inputs));
}

/**
 * A small set of primitives in the shadcn/ui idiom — copied-in components rather than a
 * dependency, styled with the tokens in globals.css.
 *
 * Kept deliberately small. The brief asks for tables, badges, queues and clear actions; every
 * component here earns its place in that list, and nothing is added speculatively.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover',
  secondary:
    'bg-surface-raised text-ink border border-border-strong hover:bg-surface-sunken',
  ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
  danger: 'bg-critical text-white hover:opacity-90',
};

export function Button({
  variant = 'primary',
  className,
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium',
        'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent',
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && !error ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
      {error ? <span className="block text-xs text-critical">{error}</span> : null}
    </label>
  );
}

type BadgeTone = 'neutral' | 'positive' | 'caution' | 'critical' | 'accent';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-ink-muted border-border-subtle',
  positive: 'bg-positive-soft text-positive border-positive/30',
  caution: 'bg-caution-soft text-caution border-caution/30',
  critical: 'bg-critical-soft text-critical border-critical/30',
  accent: 'bg-accent-soft text-accent border-accent/30',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border-subtle bg-surface-raised p-5',
        className,
      )}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A table that scrolls horizontally on a phone instead of breaking the page layout. */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-raised">
      <table className="w-full min-w-[36rem] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'border-b border-border-subtle px-4 py-2.5 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td className={cn('border-b border-border-subtle px-4 py-2.5 text-ink', className)} {...props} />
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-faint">{message}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-sm text-critical">
      {children}
    </div>
  );
}
