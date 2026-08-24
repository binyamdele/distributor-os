import 'server-only';
import { config } from '@/platform/config';
import { currentRequestContext, newCorrelationId } from './correlation';
import { log } from './logger';
import { SentryErrorReporter, parseSentryDsn } from './sentry';

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
 * A DSN that is configured but is not one this build knows how to send to.
 *
 * It logs and says so once per process rather than silently doing nothing. Setting a DSN is an
 * explicit act by an operator who then expects reports to arrive somewhere; a configuration that
 * quietly has no effect is how a team discovers, during an incident, that six months of errors
 * went nowhere.
 */
class ForwardingErrorReporter implements ErrorReporter {
  readonly name = 'forwarding';

  private warned = false;

  constructor(private readonly dsn: string) {}

  report(error: ReportedError): void {
    // Always logs first, so an outage at the error service does not lose the error.
    new LoggingErrorReporter().report(error);

    if (!this.warned) {
      this.warned = true;
      log.warn({
        event: 'error_reporting.unsupported_dsn',
        // The DSN's host only. A DSN commonly embeds a key in its userinfo.
        destination: safeHost(this.dsn),
        detail: 'ERROR_REPORTING_DSN is set but is not a Sentry DSN. Reports are logged only.',
      });
    }
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
  let settings: ReturnType<typeof config>;
  try {
    settings = config();
  } catch {
    return new LoggingErrorReporter();
  }

  const dsn = settings.ERROR_REPORTING_DSN;
  if (!dsn) {
    cached = new LoggingErrorReporter();
    return cached;
  }

  const sentry = parseSentryDsn(dsn);
  cached = sentry
    ? new SentryErrorReporter(sentry, {
        environment: settings.APP_ENV,
        // The release is the commit. It is what makes "this error started with that deploy" a
        // question Sentry can answer, and it is the same value `/api/version` reports — so a
        // report and a support call agree on what was running.
        release: settings.BUILD_SHA,
      })
    : new ForwardingErrorReporter(dsn);

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
