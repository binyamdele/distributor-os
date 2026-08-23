/**
 * Rate limiting, sized for one pilot.
 *
 * An in-process fixed-window counter. Not distributed, not durable, and not trying to be: the
 * pilot runs one container, and a Redis dependency added for a problem this deployment does not
 * have would be a new thing to operate, monitor and restore.
 *
 * What it is genuinely for:
 *
 *   - **Login.** Without it, passwords can be attempted at the speed of the network. scrypt at
 *     N=2¹⁵ makes each attempt cost the *server* real CPU too, so an unthrottled login endpoint
 *     is simultaneously a credential-stuffing target and a denial-of-service one.
 *   - **Paid provider calls.** A loop over the AI parser is somebody's money. A bug that retries
 *     is as expensive as an attacker.
 *   - **Uploads.** Bounded per-user so one client cannot fill the evidence store.
 *
 * What it is not: an anti-abuse system. A determined attacker with many IPs and many accounts is
 * out of scope for a single-tenant pilot, and pretending otherwise would be the kind of claim
 * this codebase avoids elsewhere.
 *
 * Documented limitation: counters reset when the process restarts. A deploy therefore forgives
 * outstanding limits. For a login limiter that matters little — the attacker cannot force the
 * restart — and it is written down rather than left for someone to discover.
 */

export interface RateLimitRule {
  /** Requests permitted per window. */
  readonly limit: number;
  readonly windowMs: number;
}

export const RATE_LIMITS = {
  /**
   * Ten attempts per fifteen minutes.
   *
   * Generous enough that a person mistyping a new password four times is unaffected, tight
   * enough that a dictionary is useless.
   */
  login: { limit: 10, windowMs: 15 * 60_000 },
  /** Inquiry parsing spends provider money. */
  aiParse: { limit: 30, windowMs: 60_000 },
  /** Payment extraction, likewise. */
  aiExtract: { limit: 30, windowMs: 60_000 },
  /** Evidence upload: bounded so one client cannot fill the store. */
  upload: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Stops the map growing without bound in a long-lived process. */
function sweep(now: number): void {
  if (windows.size < 5_000) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window resets. For a Retry-After header and for the message. */
  readonly retryAfterSeconds: number;
}

/**
 * Consumes one unit against `subject` for `name`.
 *
 * The subject is the caller's choice — an email for login, a user id for provider calls. Email
 * rather than IP for login on purpose: a pilot's staff are usually behind one office NAT, so
 * limiting by IP would let one person's typo lock out the whole company.
 */
export function consume(
  name: RateLimitName,
  subject: string,
  now: number = Date.now(),
): RateLimitVerdict {
  const rule = RATE_LIMITS[name];
  const key = `${name}:${subject}`;

  sweep(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= rule.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: rule.limit - existing.count,
    retryAfterSeconds: 0,
  };
}

/** Test seam, and used by the login flow to forgive a successful authentication. */
export function reset(name?: RateLimitName, subject?: string): void {
  if (!name) {
    windows.clear();
    return;
  }
  if (subject) {
    windows.delete(`${name}:${subject}`);
    return;
  }
  for (const key of windows.keys()) {
    if (key.startsWith(`${name}:`)) windows.delete(key);
  }
}
