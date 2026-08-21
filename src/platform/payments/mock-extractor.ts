import { extractedPaymentSchema, validateExtractedPayment } from './contract';
import type { ExtractedPayment } from './contract';
import type { ExtractionInput, ExtractionOutcome, PaymentExtractor } from './types';

/**
 * The deterministic mock extractor — the default, and what every test runs against.
 *
 * It does not attempt OCR. It reads a small structured header that the seed and the tests embed
 * in synthetic evidence, which makes the extraction step exercisable end to end without an
 * external service and without pretending to a capability the product does not have.
 *
 * The honest consequence: against a *real* photograph it returns `UNREADABLE`, and the workflow
 * falls through to manual entry. That is the correct failure direction. A mock that invented
 * plausible figures would make the pipeline look finished while teaching nobody how much manual
 * correction the real thing needs.
 */
export const MOCK_EVIDENCE_PREFIX = 'DISTRIBUTOR-OS-MOCK-EVIDENCE-V1';

/** Builds a synthetic evidence document the mock can read. Used by the seed and by tests. */
export function buildMockEvidence(fields: {
  amount?: string;
  currency?: string;
  providerName?: string;
  transactionReference?: string;
  paymentDate?: string;
  payerName?: string;
  /** Free text printed on the slip. Used to prove hostile content changes nothing. */
  note?: string;
}): Uint8Array {
  // A real PDF header, so the upload validator accepts it as a PDF from its magic bytes.
  const lines = [
    '%PDF-1.4',
    `% ${MOCK_EVIDENCE_PREFIX}`,
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `% ${key}: ${value}`),
    '%%EOF',
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

function readField(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^% ${key}: (.*)$`, 'm'));
  return match?.[1]?.trim() || null;
}

export class MockPaymentExtractor implements PaymentExtractor {
  readonly name = 'mock';

  private readonly rawOverrides = new Map<string, unknown>();
  private readonly failures = new Map<string, 'PROVIDER_ERROR' | 'TIMEOUT'>();

  /** Makes the extractor return an arbitrary unvalidated value, to exercise schema rejection. */
  setRawResponse(contentKey: string, raw: unknown): void {
    this.rawOverrides.set(contentKey, raw);
  }

  setFailure(contentKey: string, code: 'PROVIDER_ERROR' | 'TIMEOUT'): void {
    this.failures.set(contentKey, code);
  }

  reset(): void {
    this.rawOverrides.clear();
    this.failures.clear();
  }

  async extract(input: ExtractionInput): Promise<ExtractionOutcome> {
    const meta = {
      provider: this.name,
      model: 'deterministic-fixture-v1',
      promptVersion: 'extract-payment/v1',
      latencyMs: 0,
    };

    const text = new TextDecoder().decode(input.bytes.slice(0, 4096));

    const reference = readField(text, 'transactionReference');
    if (reference && this.failures.has(reference)) {
      return {
        ok: false,
        errorCode: this.failures.get(reference)!,
        message: 'mock extraction failure',
        meta,
      };
    }

    if (!text.includes(MOCK_EVIDENCE_PREFIX)) {
      // A real photograph. The mock cannot read it, and says so rather than guessing.
      return {
        ok: false,
        errorCode: 'UNREADABLE',
        message:
          'This evidence could not be read automatically. Enter the details by hand and review the file.',
        meta,
      };
    }

    const raw: unknown =
      reference && this.rawOverrides.has(reference)
        ? this.rawOverrides.get(reference)
        : ({
            amount: readField(text, 'amount'),
            currency: readField(text, 'currency') ?? input.expectedCurrency ?? null,
            providerName: readField(text, 'providerName'),
            transactionReference: reference,
            paymentDate: readField(text, 'paymentDate'),
            payerName: readField(text, 'payerName'),
            legibility: { amount: 0.98, reference: 0.9 },
          } satisfies Partial<ExtractedPayment> as unknown);

    const validated = extractedPaymentSchema.safeParse(raw);
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

    // Checks the shape cannot express: positive amount, real and plausible date.
    const sane = validateExtractedPayment(validated.data);
    if (!sane.ok) {
      return { ok: false, errorCode: 'SCHEMA_INVALID', message: sane.message, meta };
    }

    return { ok: true, value: validated.data, meta };
  }
}
