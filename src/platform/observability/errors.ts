import 'server-only';
import { config } from '@/platform/config';
import { currentRequestContext, newCorrelationId } from './correlation';
import { log } from './logger';

/**
 * Error reporting, behind an adapter.
 *
 * The adapter exists so that adding Sentry (or anything else) later is a new implementation of
 * one interface rather than a change to every call site — the same seam the AI provider and the
 * file store use, for the same reason.
 *
 * The default implementation logs. That is not a placeholder pretending to be an integration:
 * a structured error line with a correlation id, shipped by whatever collects container logs, is
 * a genuinely workable position for one pilot, and it is honest about what it is. A DSN can be
 * set later without touching anything but this file.
 *
 * **Nothing sensitive is sent.** Payment evidence, credentials, tokens and raw customer messages
 * are stripped by the logger's redaction before they can reach a destination, and the adapter
 * receives the already-redacted shape. An error service is a third party; a bank slip's contents
 * arriving there would be a disclosure this product's whole payment design exists to prevent.
 */

export interface ReportedError {
  readonly correlationId: string;
  /** Stable and greppable — 'payment.confirm_failed', not a sentence. */
  readonly event: string;
  readonly message: string;
  readonly stack?: string;
  readonly organizationId?: string;
  readonly userId?: string;
  readonly route?: string;
  readonly context?: Record<string, unknown>;
}

export interface ErrorReporter {
  readonly name: string;
  report(error: ReportedError): void;
}

/**
 * The default. Writes one structured error line and nothing else.
 *
 * The stack stays server-side: it goes to the log, never to a response, and never to a third
 * party unless one is deliberately configured.
 */
class LoggingErrorReporter implements ErrorReporter {
  readonly name = 'log';

  report(error: ReportedError): void {
    log.error({
      event: error.event,
      correlationId: error.correlationId,
      message: error.message,
      stack: error.stack,
      route: error.route,
      ...error.context,
    });
  }
}

/**
 * The shape a real provider would take.
 *
 * Not wired to a vendor SDK, and deliberately so: adding a dependency and a network call that
 * cannot be exercised from here would be building an integration on faith. What is real is the
 * seam, the redaction, and the fact that switching to a provider is one class.
 */
class ForwardingErrorReporter implements ErrorReporter {
  readonly name = 'forwarding';

  constructor(private readonly dsn: string) {}

  report(error: ReportedError): void {
    // Always logs first, so an outage at the error service does not lose the error.
    new LoggingErrorReporter().report(error);
    log.debug({
      event: 'error_reporting.forward_pending',
      correlationId: error.correlationId,
      // The DSN's host only. A DSN commonly embeds a key in its userinfo.
      destination: safeHost(this.dsn),
    });
  }
}

function safeHost(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return 'invalid-dsn';
  }
}

let override: ErrorReporter | null = null;
let cached: ErrorReporter | null = null;

export function errorReporter(): ErrorReporter {
  if (override) return override;
  if (cached) return cached;

  /*
   * Reading configuration must never be able to stop an error from being reported.
   *
   * This used to be a bare `config().ERROR_REPORTING_DSN`, which meant the error path depended
   * on the very thing most likely to be broken when the error path is needed. A container with
   * an invalid environment answered its readiness probe with a bare HTTP 500 and an empty body:
   * `checkReadiness` threw on `config()`, the route's catch called `captureException` to turn
   * that into a diagnosable 503, and `captureException` threw on `config()` again.
   *
   * The one code path whose job is to explain a failure could not run during the failure it
   * existed to explain. Falling back to the logging reporter is not a degradation here — with no
   * readable configuration there is no DSN to forward to anyway, and a structured log line is
   * exactly the right destination.
   */
  let dsn: string | undefined;
  try {
    dsn = config().ERROR_REPORTING_DSN;
  } catch {
    return new LoggingErrorReporter();
  }

  cached = dsn ? new ForwardingErrorReporter(dsn) : new LoggingErrorReporter();
  return cached;
}

/** Test seam. */
export function setErrorReporterOverride(next: ErrorReporter | null): void {
  override = next;
  cached = null;
}

/**
 * Records an unexpected failure and returns the reference to show the user.
 *
 * The return value is the whole point. The user sees `req_7F3A…` and nothing else; support
 * pastes it into a log filter and sees everything. No stack trace, no SQL, no file path and no
 * provider payload ever reaches a screen.
 */
export function captureException(
  error: unknown,
  fields: { event: string; context?: Record<string, unknown> } = { event: 'unhandled_error' },
): string {
  const context = currentRequestContext();
  const correlationId = context?.correlationId ?? newCorrelationId();

  const normalised =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error');

  errorReporter().report({
    correlationId,
    event: fields.event,
    message: normalised.message,
    stack: normalised.stack,
    organizationId: context?.organizationId,
    userId: context?.userId,
    route: context?.route,
    context: fields.context,
  });

  return correlationId;
}
