import 'server-only';
import { z } from 'zod';

/**
 * Environment configuration, parsed once and validated on first access.
 *
 * Fails fast and loudly. A missing SESSION_SECRET discovered at boot is an inconvenience; the
 * same secret discovered missing when a user logs in is an outage, and a silently defaulted one
 * is a security hole.
 *
 * ## Why APP_ENV exists alongside NODE_ENV
 *
 * `NODE_ENV` has three values and one of them is a lie for our purposes: staging runs a
 * production *build* (`NODE_ENV=production`) against synthetic data, and must be allowed to do
 * things production must not — reset its database, run the demo seed, use the mock AI provider.
 * Deciding those with `NODE_ENV` would mean either staging cannot rehearse a release properly or
 * production inherits staging's permissions. Neither is acceptable, so the deployment target is
 * named separately and the guards below key off `APP_ENV`.
 */

const DANGEROUS_SECRETS = new Set([
  'change-me',
  'changeme',
  'secret',
  'password',
  'development',
  'test',
]);

const schema = z
  .object({
    /**
     * The deployment this process is serving. Never inferred.
     *
     * Defaults to `development` so a developer who has never heard of this variable gets the
     * permissive behaviour, and production has to be asked for explicitly. A production
     * deployment that forgets to set it is refused by the checks below rather than quietly
     * running with development's guard rails.
     */
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: z.string().url(),
    TEST_DATABASE_URL: z.string().url().optional(),
    /**
     * Connection pool size.
     *
     * Managed Postgres plans cap total connections, and a container that opens more than its
     * share starves everything else — including the migration job and any admin session trying
     * to diagnose the problem. Small on purpose: this application holds transactions briefly and
     * a pilot serves a handful of concurrent users.
     */
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    /** Seconds a query may wait for a free connection before failing rather than hanging. */
    DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(20),

    SESSION_SECRET: z
      .string()
      .min(
        32,
        'SESSION_SECRET must be at least 32 characters; generate one with crypto.randomBytes(48)',
      ),

    /**
     * The origin this application is served from, e.g. https://pilot.example.com.
     *
     * Required in staging and production: it is what makes a redirect or an absolute link point
     * somewhere real, and what a CSRF origin check compares against.
     */
    APP_URL: z.string().url().optional(),

    /**
     * `disabled` is a first-class choice, not an absence.
     *
     * A pilot that would rather show the deterministic brief and the manual inquiry path than
     * spend money on a provider should be able to say so, and have the UI stop claiming any
     * model was involved.
     */
    AI_PROVIDER: z.enum(['mock', 'anthropic', 'disabled']).default('mock'),
    ANTHROPIC_API_KEY: z.string().optional(),
    /** Milliseconds. A provider that stops answering must not hold a request open. */
    AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),

    FILE_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    FILE_STORAGE_DIR: z.string().default('./storage'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    /**
     * Address the bucket as a path segment rather than a subdomain.
     *
     * Required by MinIO and most self-hosted gateways, whose virtual-host addressing would need
     * wildcard DNS they do not have. AWS and R2 prefer the default.
     */
    /*
     * Left undefined rather than defaulted, so the storage adapter's own rule applies: path-style
     * addressing whenever a custom `S3_ENDPOINT` is set, virtual-host for AWS itself.
     *
     * It used to default to `'false'`, which quietly disabled that rule — the adapter's
     * `forcePathStyle ?? Boolean(endpoint)` could never fire, because config always handed it an
     * explicit boolean. A deployment that set every S3 variable except this one therefore asked
     * for virtual-host addressing against a provider that does not offer it, and the SDK resolved
     * `<bucket>.<project>.supabase.co` — a hostname that does not exist. The DNS failure carries
     * no HTTP status, so it surfaced as the least informative thing readiness can say:
     * `file-store: degraded (unreachable)`.
     *
     * Set it explicitly only to override that rule.
     */
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),

    /** Where unhandled server exceptions are reported. Absent means log-only. */
    ERROR_REPORTING_DSN: z.string().optional(),

    /**
     * Deliberately opt-out rather than opt-in.
     *
     * Rate limits protect login and every paid provider call. Someone must be able to switch
     * them off while diagnosing an incident, and it must be a conscious act that is visible in
     * the environment rather than a default nobody notices.
     */
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /** Identifies the running build during support. Injected at image build time. */
    BUILD_SHA: z.string().default('unknown'),
    BUILD_TIME: z.string().default('unknown'),
    APP_VERSION: z.string().default('0.0.0'),

    /**
     * The one escape hatch, and it is narrow.
     *
     * Set only for a throwaway demonstration environment that runs a production build against
     * fabricated data. It permits the mock AI provider under `APP_ENV=production`; it does not
     * permit the demo seed, and it does not permit a destructive reset.
     */
    DEMO_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((value, ctx) => {
    const problem = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });

    // Refusing this combination rather than silently falling back to the mock: a deployment that
    // believes it is calling a real model and is not would produce confident, fabricated output.
    if (value.AI_PROVIDER === 'anthropic' && !value.ANTHROPIC_API_KEY) {
      problem('AI_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is empty.', 'ANTHROPIC_API_KEY');
    }

    const deployed = value.APP_ENV === 'production' || value.APP_ENV === 'staging';

    if (deployed && !value.APP_URL) {
      problem(`APP_URL is required when APP_ENV=${value.APP_ENV}.`, 'APP_URL');
    }

    if (value.APP_ENV === 'production') {
      /*
       * A production build served over plain HTTP would send the session cookie in clear text on
       * every request. The cookie is marked `secure` in production, so the browser would simply
       * not send it and nobody could stay logged in — but the check is here anyway, because
       * "logins mysteriously do not persist" is a much worse way to discover this.
       */
      if (value.APP_URL && !value.APP_URL.startsWith('https://')) {
        problem('APP_URL must use https:// in production.', 'APP_URL');
      }

      /*
       * The mock provider is a deterministic rule-based stub. Running it in production would put
       * screens in front of a distributor that imply a model read their customer's message when
       * nothing did. `disabled` is the honest way to run without a provider.
       */
      if (value.AI_PROVIDER === 'mock' && !value.DEMO_MODE) {
        problem(
          'AI_PROVIDER="mock" is refused in production. Use "disabled" to run without a provider, ' +
            'or "anthropic" with a key. Set DEMO_MODE=true only for a throwaway demo environment.',
          'AI_PROVIDER',
        );
      }

      /*
       * Local disk does not survive a container restart on managed hosting. Evidence written
       * there would vanish silently, leaving payment rows pointing at files that no longer
       * exist — and the customer's bank slip is the one thing a dispute turns on.
       */
      if (value.FILE_STORAGE_DRIVER === 'local' && !value.DEMO_MODE) {
        problem(
          'FILE_STORAGE_DRIVER="local" is refused in production: container filesystems are ' +
            'ephemeral and payment evidence would be lost on restart.',
          'FILE_STORAGE_DRIVER',
        );
      }

      if (DANGEROUS_SECRETS.has(value.SESSION_SECRET.toLowerCase().trim())) {
        problem('SESSION_SECRET is a placeholder value.', 'SESSION_SECRET');
      }

      // A secret with no variety is a secret somebody typed by holding down a key.
      if (new Set(value.SESSION_SECRET).size < 12) {
        problem('SESSION_SECRET has too little entropy to be a generated value.', 'SESSION_SECRET');
      }

      if (value.BUILD_SHA === 'unknown') {
        problem(
          'BUILD_SHA must be injected at build time so a deployed version can be identified.',
          'BUILD_SHA',
        );
      }
    }

    if (value.FILE_STORAGE_DRIVER === 's3') {
      for (const key of [
        'S3_BUCKET',
        'S3_REGION',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
      ] as const) {
        if (!value[key]) problem(`${key} is required when FILE_STORAGE_DRIVER="s3".`, key);
      }
    }
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

  cached = parsed.data;
  return cached;
}

/** Parses an arbitrary environment without touching the cache. For startup checks and tests. */
export function parseConfig(
  env: NodeJS.ProcessEnv,
): { ok: true; value: AppConfig } | { ok: false; problems: string[] } {
  const parsed = schema.safeParse(env);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  };
}

/** Test-only. Clears the memoised config so a test can vary the environment. */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Whether destructive and demo operations are permitted.
 *
 * One function, consulted by every script that can lose data, so the rule lives in one place
 * rather than being re-derived — slightly differently — in each of them.
 */
export function destructiveOperationsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const appEnv = env.APP_ENV ?? 'development';
  return appEnv === 'development' || appEnv === 'test';
}

/** The label the UI uses when it has to be honest about what is behind a feature. */
export function aiDisclosure(value: AppConfig): 'real' | 'mock' | 'none' {
  if (value.AI_PROVIDER === 'anthropic') return 'real';
  if (value.AI_PROVIDER === 'mock') return 'mock';
  return 'none';
}
