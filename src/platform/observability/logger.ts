import { currentRequestContext } from './correlation';

/**
 * Structured application logging.
 *
 * Before Phase 9 there was not a single `console.*` in `src/` — which is tidy and useless. When
 * a distributor rings up about an order that would not confirm, the answer has to come from
 * somewhere, and "reproduce it locally" is not an operational procedure.
 *
 * JSON lines, because every log platform parses them and none parses prose reliably. In
 * development they are pretty-printed instead, since a developer reading a terminal is a
 * different audience from a log aggregator.
 *
 * ## What must never appear here
 *
 * This is the rule the redaction below enforces, and it is not a style preference:
 *
 *   - payment evidence, or anything read out of a bank slip
 *   - credentials, tokens, session cookies, API keys
 *   - full customer messages (they can contain anything a customer typed)
 *   - bank account or transaction references
 *
 * Logs get shipped, indexed, retained for months and read by more people than the database is.
 * A customer's bank slip contents sitting in a log aggregator is a disclosure that no amount of
 * care elsewhere makes up for — which is why the redaction is applied centrally rather than
 * being each call site's job to remember.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Field names never written, whatever a caller passes.
 *
 * A superset of the audit log's list, plus the operational ones. Stripping is done here because
 * call sites are exactly where it will eventually be forgotten.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'tokenhash',
  'token_hash',
  'sessiontoken',
  'session_token',
  'cookie',
  'authorization',
  'secret',
  'apikey',
  'api_key',
  'anthropic_api_key',
  'databaseurl',
  'database_url',
  'sessionsecret',
  'session_secret',
  'evidence',
  'evidencetext',
  'extractedtext',
  'rawresponse',
  'transactionreference',
  'transaction_reference',
  'accountnumber',
  'account_number',
  'message',
  'customermessage',
  'rawtext',
]);

const MAX_STRING = 512;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === 'string') return truncate(value);
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redact(inner, depth + 1);
  }
  return out;
}

/** Long strings are almost always something that should not be here in full. */
function truncate(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
}

export interface LogFields {
  /** A stable, greppable identifier for what happened. Not a sentence. */
  readonly event: string;
  /** A stable domain error code where one exists. */
  readonly code?: string;
  readonly [key: string]: unknown;
}

export interface LogRecord extends Record<string, unknown> {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
}

type Sink = (record: LogRecord) => void;

let sink: Sink | null = null;
/** Test seam. Returns a restore function. */
export function setLogSink(next: Sink | null): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function minimumLevel(): LogLevel {
  const configured = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (configured in LEVEL_ORDER) return configured as LogLevel;
  return process.env.APP_ENV === 'development' ? 'debug' : 'info';
}

function emit(level: LogLevel, fields: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel()]) return;

  const context = currentRequestContext();

  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    level,
    ...(redact(fields) as Record<string, unknown>),
    event: fields.event,
    // Present only when known, so a CLI script's logs are not full of nulls.
    ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
    ...(context?.organizationId ? { organizationId: context.organizationId } : {}),
    ...(context?.userId ? { actorId: context.userId } : {}),
    ...(context?.route ? { route: context.route } : {}),
  };

  if (sink) {
    sink(record);
    return;
  }

  const line =
    process.env.APP_ENV === 'development'
      ? `${record.timestamp} ${level.toUpperCase().padEnd(5)} ${record.event}${
          record.correlationId ? ` [${record.correlationId}]` : ''
        } ${JSON.stringify(omit(record, ['timestamp', 'level', 'event', 'correlationId']))}`
      : JSON.stringify(record);

  // eslint-disable-next-line no-console -- this module is the one place logging is allowed.
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

function omit(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

export const log = {
  debug: (fields: LogFields) => emit('debug', fields),
  info: (fields: LogFields) => emit('info', fields),
  warn: (fields: LogFields) => emit('warn', fields),
  error: (fields: LogFields) => emit('error', fields),
};
