import { NARRATE_BRIEF_PROMPT_VERSION } from './brief-contract';
import type { BriefNarration, BriefNarrationInput } from './brief-contract';
import type { ParseInquiryResult } from './contract';
import { PARSE_INQUIRY_PROMPT_VERSION } from './prompt';
import type { AIProvider, AiOutcome, ParseInquiryInput } from './types';

/**
 * The provider for a deployment that has chosen to run without one.
 *
 * Every capability reports `NOT_CONFIGURED`, which is an outcome every caller already handles:
 * Phase 2 routes the inquiry to manual review with the customer's text untouched, and Phase 8
 * renders the deterministic brief. So switching a pilot to `AI_PROVIDER=disabled` exercises
 * paths that are already tested rather than a new set of branches.
 *
 * Why this exists at all, rather than an `if (aiEnabled)` at each call site: the decision then
 * lives in a dozen places and one of them eventually gets missed, usually the one that spends
 * money. A provider that politely declines is a single, unmissable answer.
 *
 * It also makes the honest product position expressible. A distributor who does not want to pay
 * for a model should get the manual workflow and screens that claim nothing — not a rule-based
 * stub presented as intelligence.
 */
export class DisabledAIProvider implements AIProvider {
  readonly name = 'disabled';

  private outcome<T>(): AiOutcome<T> {
    return {
      ok: false,
      errorCode: 'NOT_CONFIGURED',
      message: 'AI is switched off for this deployment.',
      meta: {
        provider: this.name,
        model: 'none',
        promptVersion: 'none',
        latencyMs: 0,
      },
    };
  }

  async parseInquiry(_input: ParseInquiryInput): Promise<AiOutcome<ParseInquiryResult>> {
    return {
      ...this.outcome<ParseInquiryResult>(),
      meta: {
        provider: this.name,
        model: 'none',
        promptVersion: PARSE_INQUIRY_PROMPT_VERSION,
        latencyMs: 0,
      },
    } as AiOutcome<ParseInquiryResult>;
  }

  async narrateDailyBrief(_input: BriefNarrationInput): Promise<AiOutcome<BriefNarration>> {
    return {
      ...this.outcome<BriefNarration>(),
      meta: {
        provider: this.name,
        model: 'none',
        promptVersion: NARRATE_BRIEF_PROMPT_VERSION,
        latencyMs: 0,
      },
    } as AiOutcome<BriefNarration>;
  }
}
