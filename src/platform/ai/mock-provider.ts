import {
  type BriefNarration,
  type BriefNarrationInput,
  NARRATE_BRIEF_PROMPT_VERSION,
  briefNarrationSchema,
} from './brief-contract';
import { parseInquirySchema } from './contract';
import type { ParsedIntent } from './contract';
import { PARSE_INQUIRY_PROMPT_VERSION } from './prompt';
import type { AIProvider, AiOutcome, ParseInquiryInput } from './types';
import type { ParseInquiryResult } from './contract';

/**
 * The deterministic mock provider — the default, and the one every test runs against.
 *
 * Determinism is the whole point: the same message always produces the same result, so a test
 * that passes today passes tomorrow, and a change in behaviour is attributable to a code change
 * rather than to model sampling. It also means the entire product runs with no API key, which
 * matters for a pilot in Addis where a key is a cost and a dependency.
 *
 * It is a rule-based extractor, not a simulation of a language model. It is deliberately
 * mediocre at natural language — it will miss phrasings a real model would catch. That is the
 * correct failure direction: work that reaches the salesperson unparsed is visible, whereas a
 * mock that flattered the pipeline would hide how much review the real thing needs.
 *
 * Everything it returns still goes through the same Zod validation as a real provider's output.
 * The mock has no privileged path into the business layer.
 */

/**
 * A documented sentinel for the seeded "invalid AI schema" demo scenario.
 *
 * A message containing this token makes the mock emit a response that fails validation, so the
 * recoverable failure path can be exercised in the demo and in E2E without a test-only API.
 * Real customer text will not contain it, and if it somehow did, the result is a parse failure
 * a person then looks at — which is the safe direction.
 */
export const MOCK_MALFORMED_SENTINEL = '__MOCK_MALFORMED_RESPONSE__';

const AMHARIC = /[ሀ-፿]/;

/**
 * Words that end a product phrase — everything after them is prose, not an item.
 *
 * `for` is in the list because "400 pcs 16mm rebar for the Kality site" is how people write,
 * and no product in a construction catalogue has "for" in its name. A real model would not need
 * the crutch; the mock does, and being explicit about it is better than the alternative, which
 * is a demo that silently finds nothing in half its own scenarios.
 */
const TRAILING_NOISE =
  /\b(please|pls|kindly|send|today|todays|price|prices|quote|quotation|asap|urgent|urgently|thanks|thank you|regards|for)\b.*$/i;

const LEADING_NOISE = /^(?:and|also|plus|then|እና)\s+/i;

const DESTINATION_PATTERNS = [
  /\bdeliver(?:y|ed)?\s+(?:to|at)\s+([^.,\n]+)/i,
  /\bdeliver\s+(?:to|at)\s+([^.,\n]+)/i,
  /\bsite\s+(?:is\s+)?(?:at|in)\s+([^.,\n]+)/i,
  /\bto\s+be\s+delivered\s+(?:to|at)\s+([^.,\n]+)/i,
];

const UNIT_WORDS = new Set([
  'bag',
  'bags',
  'sack',
  'sacks',
  'pc',
  'pcs',
  'piece',
  'pieces',
  'no',
  'nos',
  'unit',
  'units',
  'm3',
  'cbm',
  'm2',
  'sqm',
  'kg',
  'kgs',
  'kilo',
  'kilos',
  'quintal',
  'quintals',
  'qt',
  'ton',
  'tons',
  'tonne',
  'tonnes',
  'roll',
  'rolls',
  'sheet',
  'sheets',
  'litre',
  'litres',
  'liter',
  'liters',
  'l',
]);

interface Extracted {
  rawName: string;
  quantity: number;
  unit: string | null;
}

function extractItems(text: string): Extracted[] {
  const segments = text
    .split(/[,;\n]|\.(?:\s|$)|\band\b/i)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const items: Extracted[] = [];

  for (const segment of segments) {
    const cleaned = segment.replace(LEADING_NOISE, '').trim();

    // The first number in the segment, wherever it falls. Anchoring at the start seemed tidier
    // until "We need 400 pcs 16mm rebar" and "Called asking for 200 rebar" both extracted
    // nothing — which is how most people actually write a request.
    const leadingNumber = cleaned.match(/(\d[\d,]*)\s*(?:x\s+)?(.*)$/i);
    if (!leadingNumber) continue;

    const quantity = Number(leadingNumber[1]!.replace(/,/g, ''));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    let rest = (leadingNumber[2] ?? '').trim();

    // A unit word, if the customer gave one right after the number.
    let unit: string | null = null;
    const firstWord = rest.match(/^([\p{L}]+)\b\s*(.*)$/u);
    if (firstWord && UNIT_WORDS.has(firstWord[1]!.toLowerCase())) {
      unit = firstWord[1]!;
      rest = (firstWord[2] ?? '').trim();
    }

    rest = rest
      .replace(/^of\s+/i, '')
      .replace(TRAILING_NOISE, '')
      .replace(/[.\s]+$/, '')
      .trim();

    // A bare number with no product ("we need 500") carries no request.
    if (!rest || !/[\p{L}\d]/u.test(rest)) continue;

    items.push({ rawName: rest, quantity, unit });
  }

  return items;
}

function detectIntent(text: string, itemCount: number): ParsedIntent {
  const lower = text.toLowerCase();
  if (/\b(paid|payment|receipt|transfer|deposit)\b/.test(lower)) return 'PAYMENT_QUERY';
  if (/\b(where is|when will|delivery status|arrive|arrived)\b/.test(lower)) return 'DELIVERY_QUERY';
  if (/\b(my order|order number|so-\d+)\b/.test(lower)) return 'ORDER_FOLLOW_UP';
  if (itemCount > 0) {
    if (/\b(price|prices|quote|quotation|cost|ዋጋ)\b/.test(lower)) return 'REQUEST_QUOTATION';
    if (/\b(in stock|available|availability|do you have)\b/.test(lower)) return 'STOCK_ENQUIRY';
    return 'REQUEST_QUOTATION';
  }
  if (/\b(in stock|available|availability|do you have)\b/.test(lower)) return 'STOCK_ENQUIRY';
  return 'UNKNOWN';
}

function detectDestination(text: string): string | null {
  for (const pattern of DESTINATION_PATTERNS) {
    const found = text.match(pattern);
    if (found?.[1]) return found[1].trim().replace(/[.\s]+$/, '');
  }
  return null;
}

export class MockAIProvider implements AIProvider {
  readonly name = 'mock';

  /** Raw, pre-validation responses keyed by exact input text. Test hook. */
  private readonly rawOverrides = new Map<string, unknown>();
  private readonly failures = new Map<string, { code: 'PROVIDER_ERROR' | 'TIMEOUT'; message: string }>();
  private readonly seen: string[] = [];

  /** Narration fixtures. Set to exercise invention, malformed output and provider failure. */
  private briefRaw: unknown = undefined;
  private briefFailure: { code: 'PROVIDER_ERROR' | 'TIMEOUT' | 'NOT_CONFIGURED'; message: string } | null =
    null;
  /** Every narration input the provider was handed, so a test can assert what was disclosed. */
  readonly briefInputsSeen: BriefNarrationInput[] = [];

  setBriefResponse(raw: unknown): void {
    this.briefRaw = raw;
  }

  setBriefFailure(code: 'PROVIDER_ERROR' | 'TIMEOUT' | 'NOT_CONFIGURED', message: string): void {
    this.briefFailure = { code, message };
  }

  resetBrief(): void {
    this.briefRaw = undefined;
    this.briefFailure = null;
    this.briefInputsSeen.length = 0;
  }

  /** Makes the provider return an arbitrary unvalidated value, to exercise schema rejection. */
  setRawResponse(text: string, raw: unknown): void {
    this.rawOverrides.set(text, raw);
  }

  /** Makes the provider fail outright, to exercise the provider-error path. */
  setFailure(text: string, code: 'PROVIDER_ERROR' | 'TIMEOUT', message = 'mock failure'): void {
    this.failures.set(text, { code, message });
  }

  /** Every input this provider has been asked to parse. Used to assert on prompt content. */
  recordedInputs(): readonly string[] {
    return this.seen;
  }

  reset(): void {
    this.rawOverrides.clear();
    this.failures.clear();
    this.seen.length = 0;
  }

  async parseInquiry(input: ParseInquiryInput): Promise<AiOutcome<ParseInquiryResult>> {
    this.seen.push(input.text);

    const meta = {
      provider: this.name,
      model: 'deterministic-rules-v1',
      promptVersion: PARSE_INQUIRY_PROMPT_VERSION,
      latencyMs: 0,
    };

    const failure = this.failures.get(input.text);
    if (failure) {
      return { ok: false, errorCode: failure.code, message: failure.message, meta };
    }

    const raw = this.rawOverrides.has(input.text)
      ? this.rawOverrides.get(input.text)
      : input.text.includes(MOCK_MALFORMED_SENTINEL)
        ? {
            // Shaped to look plausible while violating the contract in three ways at once:
            // an unknown intent, a fractional quantity, and a price field that does not exist.
            intent: 'MAKE_IT_FREE',
            items: [{ rawName: 'OPC cement', quantity: 2.5, unit: 'bag', unitPrice: 1 }],
          }
        : this.deterministicParse(input.text);

    const validated = parseInquirySchema.safeParse(raw);
    if (!validated.success) {
      return {
        ok: false,
        errorCode: 'SCHEMA_INVALID',
        message: validated.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
        meta,
      };
    }

    return { ok: true, value: validated.data, meta };
  }

  /**
   * Narrates a set of figures, deterministically.
   *
   * Composes sentences from the supplied values and nothing else — which is what the real
   * prompt asks a model to do, so a test passing here is testing the same contract. It never
   * introduces a number of its own, so the grounding check should pass on its output every
   * time; a test that makes it fail has to say so explicitly via `setBriefResponse`.
   */
  async narrateDailyBrief(input: BriefNarrationInput): Promise<AiOutcome<BriefNarration>> {
    this.briefInputsSeen.push(input);

    const meta = {
      provider: this.name,
      model: 'deterministic-rules-v1',
      promptVersion: NARRATE_BRIEF_PROMPT_VERSION,
      latencyMs: 0,
    };

    if (this.briefFailure) {
      return {
        ok: false,
        errorCode: this.briefFailure.code,
        message: this.briefFailure.message,
        meta,
      };
    }

    const raw = this.briefRaw !== undefined ? this.briefRaw : this.composeNarration(input);

    const validated = briefNarrationSchema.safeParse(raw);
    if (!validated.success) {
      return {
        ok: false,
        errorCode: 'SCHEMA_INVALID',
        message: validated.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
        meta,
      };
    }

    return { ok: true, value: validated.data, meta };
  }

  private composeNarration(input: BriefNarrationInput): unknown {
    const highlights: string[] = [];
    const attention: string[] = [];

    const orders = input.counts.ordersCreated ?? 0;
    const orderValue = input.amounts.orderValueToday;
    const payments = input.amounts.paymentsConfirmedToday;
    const overdue = input.amounts.overdueReceivables;

    const summary =
      orders > 0 && orderValue
        ? `Today brought ${orders} sales orders worth ${orderValue}.`
        : 'No sales orders have been recorded today.';

    if (payments) highlights.push(`Confirmed payments today came to ${payments}.`);
    if (overdue) attention.push(`${overdue} remains overdue.`);

    for (const [kind, count] of Object.entries(input.attentionByKind)) {
      attention.push(`${count} item(s) of type ${kind} need attention.`);
    }

    return { summary, highlights: highlights.slice(0, 5), attention: attention.slice(0, 6) };
  }

  private deterministicParse(text: string): unknown {
    const items = extractItems(text);
    return {
      intent: detectIntent(text, items.length),
      detectedLanguage: AMHARIC.test(text) ? 'am' : 'en',
      customerName: null,
      destinationText: detectDestination(text),
      items,
    };
  }
}
