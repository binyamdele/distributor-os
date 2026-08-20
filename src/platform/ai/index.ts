import { config } from '@/platform/config';
import { AnthropicAIProvider } from './anthropic-provider';
import { MockAIProvider } from './mock-provider';
import type { AIProvider } from './types';

export * from './contract';
export * from './types';
export { MOCK_MALFORMED_SENTINEL, MockAIProvider } from './mock-provider';
export { AnthropicAIProvider } from './anthropic-provider';
export {
  PARSE_INQUIRY_PROMPT_VERSION,
  PARSE_INQUIRY_SYSTEM_PROMPT,
  buildParseInquiryUserMessage,
} from './prompt';

/**
 * The provider the application uses.
 *
 * A module-level singleton for the mock, so tests and the seed can register fixtures on the
 * same instance the application will consult. `config()` refuses the combination of
 * `AI_PROVIDER=anthropic` with an empty key, so there is no path where the system believes it
 * is calling a real model and is silently not.
 */
const mock = new MockAIProvider();

let override: AIProvider | null = null;

export function aiProvider(): AIProvider {
  if (override) return override;

  const { AI_PROVIDER, ANTHROPIC_API_KEY } = config();
  if (AI_PROVIDER === 'anthropic') {
    return new AnthropicAIProvider(ANTHROPIC_API_KEY ?? '');
  }
  return mock;
}

/** The mock instance the application would use, for registering fixtures. */
export function mockAiProvider(): MockAIProvider {
  return mock;
}

/** Test seam: force a specific provider. Pass null to restore configuration-driven selection. */
export function setAiProviderOverride(provider: AIProvider | null): void {
  override = provider;
}
