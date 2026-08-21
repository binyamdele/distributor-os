import { MockPaymentExtractor } from './mock-extractor';
import type { PaymentExtractor } from './types';

export * from './contract';
export * from './types';
export {
  MOCK_EVIDENCE_PREFIX,
  MockPaymentExtractor,
  buildMockEvidence,
} from './mock-extractor';

/**
 * The extractor the application uses.
 *
 * Only the deterministic mock is wired. A real OCR or vision provider implements the same
 * `extract` method and is selected here — the seam is real, and nothing in the payment workflow
 * names a vendor.
 *
 * There is deliberately no `PAYMENT_EXTRACTOR=...` configuration yet. Adding a switch for a
 * provider that does not exist would suggest one could be turned on, and this codebase has never
 * contacted an OCR service.
 */
const mock = new MockPaymentExtractor();

let override: PaymentExtractor | null = null;

export function paymentExtractor(): PaymentExtractor {
  return override ?? mock;
}

/** The mock instance the application would use, for registering fixtures. */
export function mockPaymentExtractor(): MockPaymentExtractor {
  return mock;
}

/** Test seam: force a specific extractor. Pass null to restore the default. */
export function setPaymentExtractorOverride(extractor: PaymentExtractor | null): void {
  override = extractor;
}
