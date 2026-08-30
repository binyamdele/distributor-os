import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ErrorReporter, ReportedError } from './errors';
import { log } from './logger';

/**
 * Sends server exceptions to Sentry, over Sentry's envelope endpoint, with no vendor SDK.
 *
 * ## Why no SDK
 *
 * `@sentry/node` installs auto-instrumentation: it monkey-patches http, the Postgres driver and
 * the framework, and it captures request bodies and query parameters by default. In an
 * application whose whole payment design rests on evidence never leaving the building, a
 * dependency that helpfully collects request payloads is the wrong shape. The envelope endpoint
 * is a documented HTTP API, and one POST of a JSON body is the entire integration — which means
 * *everything that leaves this process is visible in this file*.
 *
 * ## What is sent, and what is not
 *
 * Sent: the exception type, a scrubbed message, the correlation id, the route, the environment,
 * the release, and the organization and user ids.
 *
 * Never sent: payment evidence, extracted receipt text, raw customer messages, transaction
 * references, account numbers, credentials, tokens or session material. `scrub()` below is the
 * enforcement, and it works by removing shapes rather than by trusting call sites to have
 * remembered — because call sites are exactly where it gets forgotten.
 *
 * Organization and user ids are deliberately *included*: they are opaque uuids, they carry no
 * personal data on their own, and without them a report cannot be traced back to the tenant that
 * hit it, which is most of the value during a pilot.
 *
 * ## Failure posture
 *
 * Nothing here can break a request. The local structured log is written first and always, the
 * send is fire-and-forget behind a timeout, and every failure path is swallowed after being
 * logged. An error reporter that can throw turns one failure into two, and the second one has no
 * reporter left to describe it.
 */

interface Dsn {
  readonly envelopeUrl: string;
  readonly publicKey: string;
  readonly host: string;
}

/**
 * `https://<publicKey>@<host>/<projectId>` → the envelope endpoint for that project.
 *
 * Returns null rather than throwing for anything that is not a Sentry DSN, so a deployment that
 * points `ERROR_REPORTING_DSN` at something else degrades to logging instead of failing to boot.
 */
export function parseSentryDsn(dsn: string): Dsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || !projectId) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    return {
      envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey: url.username,
      host: url.host,
    };
  } catch {
    return null;
  }
}

/**
 * What happened to one delivery attempt.
 *
 * `report()` ignores this — reporting an error must never depend on telemetry succeeding. It
 * exists so an operator can *verify* the path end to end and get a non-zero exit when Sentry
 * refuses, which is the whole point of a verification command.
 */
export interface DeliveryOutcome {
  readonly accepted: boolean;
  readonly eventId: string;
  /** Host only. The DSN's userinfo is its public key and must not be printed or logged. */
  readonly host: string;
  readonly status?: number;
  readonly reason?: string;
}

const MAX_MESSAGE = 300;
const MAX_STACK = 4_000;

/**
 * Removes the shapes that must never reach a third party.
 *
 * Ordered deliberately: credentials first, then long opaque runs, then digit sequences. Each
 * pattern exists because of something this application actually handles:
 *
 *   - a connection string or URL with a password in it, which is how a database URL leaks
 *   - a long base64 or hex run — a session token, an API key, a content hash, a signature
 *   - eight or more consecutive digits — a bank account number or a transaction reference. Order
 *     numbers are `SO-2026-05011` and survive, because the hyphens break the run
 *
 * The last one is deliberately blunt. A partially-masked bank reference is still a bank
 * reference, and §9's requirement is "no complete bank/payment references" — so the whole run
 * goes. Losing a quantity from an error message costs a support call; leaking a customer's
 * account number costs the distributor's trust.
 */
export function scrub(value: string): string {
  return value
    .replace(/\b[a-zA-Z][a-zA-Z+.-]*:\/\/[^\s@/]+:[^\s@/]+@/g, '$1://[redacted]@')
    .replace(/[a-zA-Z0-9_-]{32,}/g, '[redacted]')
    .replace(/\d{8,}/g, '[redacted]')
    .slice(0, MAX_MESSAGE);
}

export class SentryErrorReporter implements ErrorReporter {
  readonly name = 'sentry';

  private readonly dsn: Dsn;
  private readonly environment: string;
  private readonly release: string;

  constructor(dsn: Dsn, options: { environment: string; release: string }) {
    this.dsn = dsn;
    this.environment = options.environment;
    this.release = options.release;
  }

  report(error: ReportedError): void {
    /*
     * The local line first, and unconditionally.
     *
     * If Sentry is unreachable — entirely possible during the incident being reported — the
     * error must not disappear with it. The log is the record; Sentry is the convenience.
     */
    log.error({
      event: error.event,
      correlationId: error.correlationId,
      message: error.message,
      stack: error.stack,
      route: error.route,
      ...error.context,
    });

    void this.deliver(error).catch(() => {
      // Already logged inside send(). Swallowed here so an unhandled rejection cannot take the
      // process down over a telemetry failure.
    });
  }

  /**
   * Sends one event and reports what came back.
   *
   * Public so `ops:sentry-test` can await exactly the transport the application uses — the same
   * envelope, the same scrubbing, the same auth header — rather than a parallel curl that would
   * prove only that curl works.
   */
  async deliver(error: ReportedError): Promise<DeliveryOutcome> {
    const eventId = randomUUID().replace(/-/g, '');
    const sentAt = new Date().toISOString();

    const event = {
      event_id: eventId,
      timestamp: sentAt,
      platform: 'node',
      level: 'error',
      logger: 'distributor-os',
      environment: this.environment,
      release: this.release,
      transaction: error.route ?? undefined,
      tags: {
        correlation_id: error.correlationId,
        event: error.event,
      },
      user: error.userId ? { id: error.userId } : undefined,
      /*
       * `extra`, not `contexts`: Sentry renders extras as opaque key/values and does not index
       * or search them, which is the right treatment for an organization id.
       *
       * `error.context` is deliberately NOT forwarded. It is a free-form bag whose contents are
       * decided at hundreds of call sites, and the one thing this integration must guarantee is
       * that nothing unreviewed leaves the process. The correlation id is in the tags; whatever
       * the context held is in the local log, which is where support looks anyway.
       */
      extra: {
        organization_id: error.organizationId ?? null,
        stack: error.stack ? scrub(error.stack).slice(0, MAX_STACK) : null,
      },
      exception: {
        values: [
          {
            type: error.event,
            value: scrub(error.message),
          },
        ],
      },
    };

    const envelope =
      `${JSON.stringify({ event_id: eventId, sent_at: sentAt, dsn: undefined })}\n` +
      `${JSON.stringify({ type: 'event' })}\n` +
      `${JSON.stringify(event)}\n`;

    try {
      const response = await fetch(this.dsn.envelopeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': [
            'Sentry sentry_version=7',
            'sentry_client=distributor-os/1.0',
            `sentry_key=${this.dsn.publicKey}`,
          ].join(', '),
        },
        body: envelope,
        // Bounded, and short. A telemetry endpoint that stops answering must not hold a request
        // handler open behind it.
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        log.warn({
          event: 'error_reporting.rejected',
          correlationId: error.correlationId,
          // The host, never the DSN: the DSN's userinfo is its public key, and the whole string
          // is the kind of thing that gets copied out of a log into a ticket.
          destination: this.dsn.host,
          status: response.status,
        });
      }

      return {
        accepted: response.ok,
        eventId,
        host: this.dsn.host,
        status: response.status,
      };
    } catch (sendError) {
      const reason = sendError instanceof Error ? sendError.name : 'unknown';

      log.warn({
        event: 'error_reporting.unreachable',
        correlationId: error.correlationId,
        destination: this.dsn.host,
        reason,
      });

      return { accepted: false, eventId, host: this.dsn.host, reason };
    }
  }
}
