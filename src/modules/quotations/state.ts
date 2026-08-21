/**
 * The quotation lifecycle.
 *
 * Data rather than scattered conditionals, for the same reason as the inquiry machine: "can it
 * go there from here" needs one answer that a test can enumerate exhaustively.
 */

export const QUOTATION_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'SUPERSEDED',
  'CANCELLED',
] as const;

export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/**
 * Permitted transitions.
 *
 * Worth explaining:
 *
 *   - `APPROVED → DRAFT` is the invalidation edge. An approval-sensitive edit sends the
 *     quotation back to draft rather than to PENDING_APPROVAL, because re-queueing an approval
 *     the salesperson never asked for is a silent request in someone else's name. They resubmit
 *     deliberately, or they do not.
 *   - `PENDING_APPROVAL → DRAFT` is the same edge for an edit made while approval is pending:
 *     the request is withdrawn rather than quietly amended under the approver.
 *   - `SENT → ACCEPTED` exists for Phase 4, which converts an accepted quotation into a sales
 *     order. No Phase 3 action drives it, and no UI exposes it.
 *   - `SENT` has no path back to `DRAFT`. Once the customer has the figures, the honest move is
 *     a new version marked `SUPERSEDED`, not a quiet edit of what they were sent.
 */
const TRANSITIONS: Readonly<Record<QuotationStatus, readonly QuotationStatus[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED', 'EXPIRED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['SENT', 'DRAFT', 'CANCELLED', 'EXPIRED'],
  SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'],
  ACCEPTED: ['SUPERSEDED'],
  REJECTED: ['SUPERSEDED'],
  EXPIRED: ['SUPERSEDED'],
  SUPERSEDED: [],
  CANCELLED: [],
};

export function canTransition(from: QuotationStatus, to: QuotationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: QuotationStatus): readonly QuotationStatus[] {
  return TRANSITIONS[from];
}

export function isTerminal(status: QuotationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses in which the commercial figures may still be changed. */
export function isEditable(status: QuotationStatus): boolean {
  return status === 'DRAFT' || status === 'PENDING_APPROVAL' || status === 'APPROVED';
}

/** Statuses from which an approval-sensitive edit must withdraw an approval or a request. */
export function withdrawsApproval(status: QuotationStatus): boolean {
  return status === 'PENDING_APPROVAL' || status === 'APPROVED';
}
