/**
 * An explicit result type, for cases where failure is an expected business outcome — a policy
 * denial, an approval requirement, a credit block — rather than a programmer error.
 *
 * Throwing is reserved for genuine bugs. A business decision must be a *value*, so it can be
 * logged, audited and rendered to the user, instead of being swallowed by a catch block.
 *
 * Ported from CommerceOS and trimmed to the codes this product can actually produce.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Unwraps a result, throwing if it is an error. Only where an error would be a bug. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(`unwrap() called on an error result: ${JSON.stringify(result.error)}`);
}

/**
 * A runtime array rather than a bare union, so the set can be iterated: the HTTP status
 * mapping is a Record keyed by this union, which means the compiler refuses an unmapped code,
 * and a test walks this list to assert no business refusal is reported as a server error.
 */
export const DOMAIN_ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  /** A read or write attempted to cross an organization boundary. Always a bug or an attack. */
  'CROSS_TENANT_ACCESS',
  'CONFLICT',
  'INVALID_STATE_TRANSITION',
  'APPROVAL_REQUIRED',
  /** The figures changed after approval was granted; it must be sought again. */
  'APPROVAL_PAYLOAD_MISMATCH',
  'INSUFFICIENT_STOCK',
  'CREDIT_BLOCKED',
  'CURRENCY_MISMATCH',
  'RATE_LIMITED',
  /** The AI returned something that failed its output schema. Never a reason to guess. */
  'AI_OUTPUT_INVALID',
  /** Somebody else's system broke. A 502, not a claim about this one. */
  'PROVIDER_ERROR',
  /** This system broke and someone should look at it. */
  'INTERNAL',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/** The codes that are not a business decision — everything else is this system working. */
export const NON_REFUSAL_CODES = ['INTERNAL', 'PROVIDER_ERROR'] as const satisfies readonly DomainErrorCode[];

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  /** Safe, non-sensitive structured context for logs and the UI. Never customer PII. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Set when the right response is human review rather than a retry. */
  readonly requiresHumanReview?: boolean;
}

export function domainError(
  code: DomainErrorCode,
  message: string,
  details?: Record<string, unknown>,
  requiresHumanReview = false,
): DomainError {
  return { code, message, details, requiresHumanReview };
}

export function fail<T = never>(
  code: DomainErrorCode,
  message: string,
  details?: Record<string, unknown>,
  requiresHumanReview = false,
): Result<T, DomainError> {
  return err(domainError(code, message, details, requiresHumanReview));
}
