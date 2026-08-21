import type { ExtractedPayment } from './contract';

/**
 * The extraction seam.
 *
 * Domain code depends on this interface, never on an OCR vendor or a model. The default is a
 * deterministic mock, so the whole payment workflow runs and tests with no external service —
 * and, more importantly, so a distributor whose OCR provider is down can still take money.
 *
 * Extraction is optional by design. Every field it produces can be typed by a Finance user
 * instead, and a failure is a recoverable state rather than a dead end.
 */

export interface ExtractionInput {
  /** The evidence bytes. Never a URL: the extractor is handed content, not a way to fetch it. */
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /**
   * The currency the order is in, as a hint for reading an ambiguous amount.
   *
   * A hint only. The extractor may report a different currency, and a mismatch becomes a factor
   * for Finance to see rather than something quietly normalised away.
   */
  readonly expectedCurrency?: string;
}

export interface ExtractionMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly latencyMs: number;
}

export type ExtractionOutcome =
  | { readonly ok: true; readonly value: ExtractedPayment; readonly meta: ExtractionMetadata }
  | {
      readonly ok: false;
      readonly errorCode: 'SCHEMA_INVALID' | 'PROVIDER_ERROR' | 'TIMEOUT' | 'NOT_CONFIGURED' | 'UNREADABLE';
      /** Safe to show an operator. Never a raw provider payload, never receipt content. */
      readonly message: string;
      readonly meta: ExtractionMetadata;
    };

export interface PaymentExtractor {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ExtractionOutcome>;
}
