/**
 * The inquiry lifecycle.
 *
 * Written as data rather than as scattered `if` statements, so that "can this inquiry go there
 * from here" has exactly one answer and a test can enumerate every pair. An inquiry that moves
 * illegally is a bug that shows up months later as a quotation built from unreviewed items.
 */

export const INQUIRY_STATUSES = [
  'RECEIVED',
  'PARSING',
  'NEEDS_REVIEW',
  'READY_FOR_QUOTE',
  'PARSE_FAILED',
  'CANCELLED',
] as const;

export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/**
 * Permitted transitions.
 *
 * Three are worth explaining:
 *
 *   - `READY_FOR_QUOTE -> NEEDS_REVIEW`. Readiness is a statement about a specific set of
 *     reviewed items. Editing any of them withdraws that statement rather than leaving a stale
 *     one standing — the same reasoning as invalidating an approval when the figures change.
 *   - `PARSE_FAILED -> PARSING`. A failed parse is recoverable, not terminal. The customer's
 *     text is intact, so trying again costs nothing.
 *   - `READY_FOR_QUOTE` has no path to `CANCELLED`. Phase 3 consumes ready inquiries; cancelling
 *     one out from under a quotation being drafted is a race this phase does not need to have.
 */
const TRANSITIONS: Readonly<Record<InquiryStatus, readonly InquiryStatus[]>> = {
  RECEIVED: ['PARSING', 'CANCELLED'],
  PARSING: ['NEEDS_REVIEW', 'PARSE_FAILED'],
  NEEDS_REVIEW: ['READY_FOR_QUOTE', 'PARSING', 'CANCELLED'],
  READY_FOR_QUOTE: ['NEEDS_REVIEW'],
  PARSE_FAILED: ['PARSING', 'CANCELLED'],
  CANCELLED: [],
};

export function canTransition(from: InquiryStatus, to: InquiryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: InquiryStatus): readonly InquiryStatus[] {
  return TRANSITIONS[from];
}

export function isTerminal(status: InquiryStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses from which the inquiry is still being worked on. */
export function isOpen(status: InquiryStatus): boolean {
  return status !== 'CANCELLED' && status !== 'READY_FOR_QUOTE';
}
