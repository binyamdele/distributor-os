import {
  type BriefNarration,
  type BriefNarrationInput,
  NARRATE_BRIEF_JSON_SCHEMA,
  NARRATE_BRIEF_PROMPT_VERSION,
  NARRATE_BRIEF_SYSTEM_PROMPT,
  briefNarrationSchema,
} from './brief-contract';
import { PARSE_INQUIRY_JSON_SCHEMA, parseInquirySchema } from './contract';
import type { ParseInquiryResult } from './contract';
import {
  PARSE_INQUIRY_PROMPT_VERSION,
  PARSE_INQUIRY_SYSTEM_PROMPT,
  buildParseInquiryUserMessage,
} from './prompt';
import type { AIProvider, AiOutcome, ParseInquiryInput } from './types';

/**
 * The production provider adapter.
 *
 * **Not exercised in Phase 2.** No API key is configured in this environment, `AI_PROVIDER`
 * defaults to `mock`, and nothing in the test suite or the demo calls this class. It exists so
 * that the seam is real rather than hypothetical — the interface is implemented twice, which is
 * the only way to know it is actually an interface — and so that turning it on later is a
 * configuration change rather than a refactor.
 *
 * Treat any claim that this has talked to Anthropic as unverified until someone runs it with a
 * key and says so.
 *
 * Two structural points that must survive any future edit:
 *
 *   1. The customer's text goes in its own user turn, wrapped in a delimiter, and is never
 *      concatenated into the system prompt. A system prompt built by string-joining untrusted
 *      text is how instruction-hierarchy defences get quietly dismantled.
 *   2. The response is validated by the same Zod schema the mock's output is. There is no
 *      "trust the real provider more" path — a schema-invalid answer from a real model is a
 *      parse failure exactly as it is from the mock.
 */
export class AnthropicAIProvider implements AIProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-sonnet-5',
    private readonly baseUrl = 'https://api.anthropic.com/v1/messages',
    private readonly timeoutMs = 20_000,
  ) {}

  /**
   * Narrates already-calculated figures.
   *
   * Held to the contract by a forced tool call with the same schema that validates the answer,
   * exactly as `parseInquiry` is. The input carries no customer name, no order number and no
   * message text — only counts and pre-formatted amounts — so a provider outage, a log at the
   * far end, or a prompt-injection attempt in a label all cost the same thing: a paragraph the
   * caller discards in favour of the deterministic brief.
   */
  async narrateDailyBrief(input: BriefNarrationInput): Promise<AiOutcome<BriefNarration>> {
    const startedAt = Date.now();
    const meta = {
      provider: this.name,
      model: this.model,
      promptVersion: NARRATE_BRIEF_PROMPT_VERSION,
      latencyMs: 0,
    };

    if (!this.apiKey) {
      return {
        ok: false,
        errorCode: 'NOT_CONFIGURED',
        message: 'No Anthropic API key is configured.',
        meta,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          temperature: 0,
          system: NARRATE_BRIEF_SYSTEM_PROMPT,
          tools: [
            {
              name: 'write_brief',
              description: 'Write the daily summary from the supplied figures.',
              input_schema: NARRATE_BRIEF_JSON_SCHEMA,
            },
          ],
          tool_choice: { type: 'tool', name: 'write_brief' },
          messages: [{ role: 'user', content: JSON.stringify(input) }],
        }),
      });

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        return {
          ok: false,
          errorCode: 'PROVIDER_ERROR',
          message: `Provider returned HTTP ${response.status}.`,
          meta: { ...meta, latencyMs },
        };
      }

      const body = (await response.json()) as {
        content?: { type: string; name?: string; input?: unknown }[];
      };
      const toolUse = body.content?.find(
        (block) => block.type === 'tool_use' && block.name === 'write_brief',
      );

      const validated = briefNarrationSchema.safeParse(toolUse?.input);
      if (!validated.success) {
        return {
          ok: false,
          errorCode: 'SCHEMA_INVALID',
          message: validated.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
          meta: { ...meta, latencyMs },
        };
      }

      return { ok: true, value: validated.data, meta: { ...meta, latencyMs } };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        errorCode: aborted ? 'TIMEOUT' : 'PROVIDER_ERROR',
        message: aborted ? 'The provider did not answer in time.' : 'The provider call failed.',
        meta: { ...meta, latencyMs },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async parseInquiry(input: ParseInquiryInput): Promise<AiOutcome<ParseInquiryResult>> {
    const startedAt = Date.now();
    const meta = {
      provider: this.name,
      model: this.model,
      promptVersion: PARSE_INQUIRY_PROMPT_VERSION,
      latencyMs: 0,
    };

    if (!this.apiKey) {
      return {
        ok: false,
        errorCode: 'NOT_CONFIGURED',
        message: 'No Anthropic API key is configured.',
        meta,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          temperature: 0,
          system: PARSE_INQUIRY_SYSTEM_PROMPT,
          // A forced tool call is how the model is held to the contract. The schema handed
          // over is the same one that validates the answer.
          tools: [
            {
              name: 'report_inquiry',
              description: 'Report the purchase request extracted from the customer message.',
              input_schema: PARSE_INQUIRY_JSON_SCHEMA,
            },
          ],
          tool_choice: { type: 'tool', name: 'report_inquiry' },
          messages: [
            { role: 'user', content: buildParseInquiryUserMessage(input.text) },
          ],
        }),
      });

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        return {
          ok: false,
          errorCode: 'PROVIDER_ERROR',
          // Status only. A provider error body can echo the request, and the request contains
          // customer text that has no business in a log line.
          message: `Provider returned HTTP ${response.status}.`,
          meta: { ...meta, latencyMs },
        };
      }

      const body = (await response.json()) as {
        content?: { type: string; name?: string; input?: unknown }[];
      };
      const toolUse = body.content?.find(
        (block) => block.type === 'tool_use' && block.name === 'report_inquiry',
      );

      const validated = parseInquirySchema.safeParse(toolUse?.input);
      if (!validated.success) {
        return {
          ok: false,
          errorCode: 'SCHEMA_INVALID',
          message: validated.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
          meta: { ...meta, latencyMs },
        };
      }

      return { ok: true, value: validated.data, meta: { ...meta, latencyMs } };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        errorCode: aborted ? 'TIMEOUT' : 'PROVIDER_ERROR',
        message: aborted ? `No response within ${this.timeoutMs}ms.` : 'The provider call failed.',
        meta: { ...meta, latencyMs },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
