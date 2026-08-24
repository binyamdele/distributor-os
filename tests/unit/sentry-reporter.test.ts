import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryErrorReporter, parseSentryDsn, scrub } from '@/platform/observability/sentry';

/**
 * What leaves the process when an exception is reported.
 *
 * Sentry is a third party. The application's entire payment design rests on evidence never
 * leaving the building, so an integration that ships error context to somebody else's servers has
 * to be able to state exactly what it sends — and prove it, against a real HTTP server, rather
 * than assert it in a comment.
 */

let server: Server | null = null;

async function listen(status = 200) {
  const received: { body: string; url: string; headers: Record<string, unknown> }[] = [];

  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ body, url: request.url ?? '', headers: request.headers });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{"id":"abc"}');
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { received, port };
}

/** The envelope is three JSON lines; the event is the third. */
function eventFrom(body: string): Record<string, unknown> {
  const lines = body.trim().split('\n');
  return JSON.parse(lines[2]!) as Record<string, unknown>;
}

async function settle() {
  // report() is fire-and-forget by design, so the request is in flight when it returns.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('parsing a DSN', () => {
  it('derives the envelope endpoint for the project', () => {
    const dsn = parseSentryDsn('https://abc123@o42.ingest.sentry.io/7654321');

    expect(dsn?.envelopeUrl).toBe('https://o42.ingest.sentry.io/api/7654321/envelope/');
    expect(dsn?.publicKey).toBe('abc123');
  });

  it('returns null for anything that is not a Sentry DSN', () => {
    // A deployment that points ERROR_REPORTING_DSN at something else must degrade to logging,
    // not fail to boot over a telemetry setting.
    expect(parseSentryDsn('https://example.com/webhook')).toBeNull();
    expect(parseSentryDsn('not-a-url')).toBeNull();
    expect(parseSentryDsn('https://key@host/')).toBeNull();
  });
});

describe('scrubbing', () => {
  it('removes credentials embedded in a URL', () => {
    /*
     * An https URL rather than a realistic Postgres connection string, deliberately.
     *
     * The rule being tested is "credentials in a URL", which is scheme-agnostic — and a
     * convincing `postgresql://user:password@host/db` in a test file is exactly what
     * `ops:scan-secrets` is built to catch. It caught this one. Loosening the scanner so a test
     * fixture could keep its shape would trade a real control for a cosmetic preference.
     */
    expect(scrub('callback failed: https://svc:t0pS3cret@api.example.com/v1/hook')).not.toContain(
      't0pS3cret',
    );
  });

  it('removes long opaque runs — tokens, keys, hashes', () => {
    const token = 'synthetic_token_for_scrub_test_0000000000';
    expect(scrub(`auth failed for ${token}`)).not.toContain(token);
  });

  it('removes anything that could be a bank account or transaction reference', () => {
    /*
     * Deliberately blunt. A partially-masked bank reference is still a bank reference, and the
     * requirement is no *complete* payment references — so the whole run goes. Losing a figure
     * from an error message costs a support call; leaking a customer's account number costs the
     * distributor's trust.
     */
    expect(scrub('no match for reference 100024456712')).not.toContain('100024456712');
  });

  it('leaves an order number readable, because the hyphens break the run', () => {
    // The most common thing in an error message, and the most useful. It survives.
    expect(scrub('order SO-2026-05011 has no reservation')).toContain('SO-2026-05011');
  });

  it('caps the length, whatever was thrown', () => {
    expect(scrub('x'.repeat(5_000)).length).toBeLessThanOrEqual(300);
  });
});

describe('what is actually sent', () => {
  const dsnFor = (port: number) => parseSentryDsn(`http://publickey@127.0.0.1:${port}/9`)!;

  it('sends an envelope Sentry would accept, tagged with the release and correlation id', async () => {
    const { received, port } = await listen();

    new SentryErrorReporter(dsnFor(port), {
      environment: 'staging',
      release: '2f6ae4fa34560456a26f6f8e12d8a201bf8e82d7',
    }).report({
      correlationId: 'req_ABC123',
      event: 'payment.confirm_failed',
      message: 'row is locked',
      stack: 'Error: row is locked\n    at confirmPayment (payments.ts:1)',
      organizationId: '11111111-1111-1111-1111-111111111111',
      userId: '22222222-2222-2222-2222-222222222222',
      route: '/payments/review',
      context: { transactionReference: 'FT26082400001', customerMessage: 'send me 40 bags' },
    });

    await settle();
    expect(received).toHaveLength(1);

    expect(received[0]!.url).toBe('/api/9/envelope/');
    expect(String(received[0]!.headers['x-sentry-auth'])).toContain('sentry_key=publickey');

    const event = eventFrom(received[0]!.body);
    expect(event.environment).toBe('staging');
    // The release is the commit, so "this error started with that deploy" is answerable, and it
    // is the same value /api/version reports.
    expect(event.release).toBe('2f6ae4fa34560456a26f6f8e12d8a201bf8e82d7');
    expect((event.tags as Record<string, string>).correlation_id).toBe('req_ABC123');
    expect(event.transaction).toBe('/payments/review');
  });

  it('never forwards the free-form context bag', async () => {
    const { received, port } = await listen();

    new SentryErrorReporter(dsnFor(port), { environment: 'staging', release: 'abc' }).report({
      correlationId: 'req_ABC123',
      event: 'payment.confirm_failed',
      message: 'row is locked',
      organizationId: '11111111-1111-1111-1111-111111111111',
      context: {
        transactionReference: 'FT26082400001',
        customerMessage: 'send me 40 bags of cement to Bole',
        evidenceText: 'COMMERCIAL BANK OF ETHIOPIA … 1000244567',
      },
    });

    await settle();
    const body = received[0]!.body;

    /*
     * The context is decided at hundreds of call sites. Forwarding it would mean the guarantee
     * "no payment evidence and no raw customer message leaves this process" depended on every
     * one of them having remembered. It is dropped wholesale instead; whatever it held is in the
     * local log, which is where support looks anyway.
     */
    expect(body).not.toContain('FT26082400001');
    expect(body).not.toContain('send me 40 bags');
    expect(body).not.toContain('COMMERCIAL BANK');
    expect(body).not.toContain('1000244567');
  });

  it('cannot break a request when Sentry rejects or disappears', async () => {
    const { port } = await listen(500);

    const report = () =>
      new SentryErrorReporter(dsnFor(port), { environment: 'staging', release: 'abc' }).report({
        correlationId: 'req_ABC123',
        event: 'test.failure',
        message: 'something failed',
      });

    // A 500 from the ingest endpoint, and an address nothing is listening on. Neither throws:
    // an error reporter that can throw turns one failure into two.
    expect(report).not.toThrow();

    const dead = parseSentryDsn('http://key@127.0.0.1:1/9')!;
    expect(() =>
      new SentryErrorReporter(dead, { environment: 'staging', release: 'abc' }).report({
        correlationId: 'req_ABC123',
        event: 'test.failure',
        message: 'something failed',
      }),
    ).not.toThrow();

    await settle();
  });
});
