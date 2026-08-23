import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * A correlation id per request, carried without threading it through every function.
 *
 * The problem this solves is a support call. A user says "it broke when I confirmed the
 * payment"; the log has four hundred lines from that minute; nothing ties them together. With a
 * correlation id the user reads out `req_7f3a…` from the error screen and the whole request is
 * one filter away — without a stack trace ever being shown to them.
 *
 * `AsyncLocalStorage` rather than a parameter on every call, because the alternative is adding a
 * context argument to several hundred functions, most of which do not log. It is Node's
 * supported mechanism for exactly this and survives `await` boundaries.
 */

export interface RequestContext {
  readonly correlationId: string;
  readonly organizationId?: string;
  readonly userId?: string;
  readonly route?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Short, unambiguous, and readable aloud over a bad phone line.
 *
 * Base32-ish alphabet with the characters people confuse removed — no 0/O, no 1/I/l. A support
 * reference that gets mistyped every second call is not a reference.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newCorrelationId(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `req_${out}`;
}

/** Runs `fn` with a correlation context available to everything it awaits. */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context, or undefined outside a request (a CLI script, a test). */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Adds what is known about the actor once a session has been resolved.
 *
 * A request starts before anyone is identified, so the organization and user arrive later. This
 * mutates the store in place rather than nesting a second scope, which would silently lose the
 * addition for anything already awaiting in the outer one.
 */
export function enrichRequestContext(fields: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, fields);
}
