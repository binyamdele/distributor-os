import type { BriefNarration, BriefNarrationInput } from './brief-contract';
import type { ParseInquiryResult } from './contract';

/**
 * The provider seam.
 *
 * Domain code depends on this interface and never on a vendor SDK, so swapping or adding a
 * provider does not touch a module, a prompt or a service. The default implementation is a
 * deterministic mock, which is what makes the whole application runnable and testable with no
 * API key present — see `.env.example`.
 *
 * Capabilities are added here as phases need them. Phase 2 needs one:
 *
 *   parseInquiry   — read an unstructured customer message into proposed items
 *
 * Phase 8 adds the second:
 *
 *   narrateDailyBrief — turn already-calculated figures into readable sentences
 *
 * Note what that capability is not allowed to be. It receives numbers that have already been
 * computed and returns prose; it cannot calculate, cannot decide, and cannot reach any record.
 * A capability named summariseSales, taking a date range and returning totals, would have put
 * the model on the wrong side of the line — so the seam is shaped to make that impossible
 * rather than discouraged.
 */

export interface ParseInquiryInput {
  /** The customer's message, verbatim. Untrusted. */
  readonly text: string;
  /** Hint only. The provider is free to disagree, and nothing is gated on the answer. */
  readonly expectedLanguage?: string;
}

export interface AiCallMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly latencyMs: number;
}

/**
 * Either a validated result or a named failure. Never a partial or coerced value.
 *
 * `SCHEMA_INVALID` is the case that matters: the provider answered, but not in the shape the
 * contract requires. Coercing that into something usable is exactly the failure mode this
 * whole design exists to prevent, so it is surfaced as a failure and the inquiry goes to a
 * recoverable state with the customer's text untouched.
 */
export type AiOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly meta: AiCallMetadata }
  | {
      readonly ok: false;
      readonly errorCode: 'SCHEMA_INVALID' | 'PROVIDER_ERROR' | 'TIMEOUT' | 'NOT_CONFIGURED';
      /** Safe to log and to show an operator. Never a raw provider payload. */
      readonly message: string;
      readonly meta: AiCallMetadata;
    };

export interface AIProvider {
  readonly name: string;
  parseInquiry(input: ParseInquiryInput): Promise<AiOutcome<ParseInquiryResult>>;
  /**
   * Narrate a set of already-calculated figures.
   *
   * Takes no identifiers and returns no numbers as data. A failure of any kind is an ordinary
   * outcome: the caller falls back to the deterministic brief, which was written first and is
   * complete on its own.
   */
  narrateDailyBrief(input: BriefNarrationInput): Promise<AiOutcome<BriefNarration>>;
}
