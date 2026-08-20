import 'server-only';
import { z } from 'zod';

/**
 * Environment configuration, parsed once and validated on first access.
 *
 * Fails fast and loudly. A missing SESSION_SECRET discovered at boot is an inconvenience; the
 * same secret discovered missing when a user logs in is an outage, and a silently defaulted
 * one is a security hole.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters; generate one with crypto.randomBytes(48)'),

  AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),

  FILE_STORAGE_DIR: z.string().default('./storage'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  // Refusing this combination rather than silently falling back to the mock: a deployment that
  // believes it is calling a real model and is not would produce confident, fabricated output.
  if (parsed.data.AI_PROVIDER === 'anthropic' && !parsed.data.ANTHROPIC_API_KEY) {
    throw new Error('AI_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is empty.');
  }

  cached = parsed.data;
  return cached;
}

/** Test-only. Clears the memoised config so a test can vary the environment. */
export function resetConfigCache(): void {
  cached = null;
}
