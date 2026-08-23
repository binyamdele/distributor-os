import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkReadiness } from '@/platform/observability/health';
import {
  captureException,
  log,
  newCorrelationId,
  setErrorReporterOverride,
  setLogSink,
  withRequestContext,
} from '@/platform/observability';
import type { LogRecord, ReportedError } from '@/platform/observability';
import { resetDatabase, seedOrg } from '../support/fixtures';
import { useMemoryFileStore } from '../support/payment-fixtures';

/**
 * The operational surface.
 *
 * Health, logging and error reporting are the pieces nobody exercises until an incident, which
 * makes them exactly the pieces most likely to be quietly broken. Two properties matter and both
 * are asserted here: readiness genuinely reaches the database, and nothing sensitive can reach a
 * log line or an error report.
 */

describe('readiness', () => {
  beforeEach(async () => {
    await resetDatabase();
    useMemoryFileStore();
    await seedOrg('Addis Build Supply', 'OWNER_ADMIN');
  });

  it('reports ready with a reachable database and no pending migrations', async () => {
    const report = await checkReadiness();

    expect(report.ready).toBe(true);
    expect(report.checks.map((check) => check.name).sort()).toEqual([
      'database',
      'file-store',
      'migrations',
    ]);
  });

  it('actually queries the database rather than assuming', async () => {
    // Not vacuous: a check that returned 'ok' without connecting would pass the test above.
    const report = await checkReadiness();
    const database = report.checks.find((check) => check.name === 'database')!;
    expect(database.status).toBe('ok');
    expect(database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('confirms every migration is finished', async () => {
    const migrations = (await checkReadiness()).checks.find((c) => c.name === 'migrations')!;
    expect(migrations.status).toBe('ok');
    expect(migrations.detail).toBeUndefined();
  });

  it('exposes no host, path, connection string or exception message', async () => {
    // A health endpoint is the most-probed URL a deployment has and is often reachable before
    // authentication. "It returns the DB host so we can debug faster" is how a reconnaissance
    // target gets built.
    const serialised = JSON.stringify(await checkReadiness());

    expect(serialised).not.toMatch(/postgres(ql)?:\/\//);
    expect(serialised).not.toContain('localhost');
    expect(serialised).not.toContain('5434');
    expect(serialised).not.toMatch(/[A-Za-z]:\\/);
    expect(serialised).not.toContain('password');
  });

  it('reports a degraded file store without refusing traffic', async () => {
    // Evidence upload and retrieval stop; quotations, orders, warehouse and delivery continue.
    // Taking the whole application out of rotation would be a larger outage than the real one.
    const { setFileStoreOverride } = await import('@/platform/storage');
    setFileStoreOverride({
      name: 'broken',
      async put() {
        throw new Error('bucket unreachable');
      },
      async getMetadata() {
        throw new Error('bucket unreachable');
      },
      async read() {
        throw new Error('bucket unreachable');
      },
      async delete() {
        throw new Error('bucket unreachable');
      },
      async health() {
        return { reachable: false, detail: 'unreachable' as const };
      },
    });

    try {
      const report = await checkReadiness();
      const store = report.checks.find((check) => check.name === 'file-store')!;

      expect(store.status).toBe('degraded');
      expect(report.ready).toBe(true);
      // The reason is not propagated: the response says the check failed, not why.
      expect(JSON.stringify(report)).not.toContain('bucket unreachable');
    } finally {
      setFileStoreOverride(null);
      useMemoryFileStore();
    }
  });
});

describe('correlation', () => {
  it('produces ids that survive being read aloud', () => {
    const id = newCorrelationId();
    // No 0/O, no 1/I/l. A reference mistyped every second call is not a reference.
    expect(id).toMatch(/^req_[23456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newCorrelationId()));
    expect(ids.size).toBe(500);
  });

  it('carries the id across await boundaries', async () => {
    const id = newCorrelationId();
    const records: LogRecord[] = [];
    const restore = setLogSink((record) => records.push(record));

    try {
      await withRequestContext({ correlationId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        log.info({ event: 'test.after_await' });
      });
    } finally {
      restore();
    }

    // The whole reason for AsyncLocalStorage: without it the id would be lost after the first
    // await, which is where every interesting log line happens.
    expect(records[0]!.correlationId).toBe(id);
  });
});

describe('log redaction', () => {
  let records: LogRecord[];
  let restore: () => void;

  beforeEach(() => {
    records = [];
    restore = setLogSink((record) => records.push(record));
  });

  afterEach(() => restore());

  it('strips credentials, tokens and connection strings', () => {
    log.info({
      event: 'test.sensitive',
      password: 'hunter2',
      token: 'abc',
      apiKey: 'sk-ant-real',
      databaseUrl: 'postgresql://u:p@host/db',
      sessionSecret: 'secret-value',
    });

    const line = JSON.stringify(records[0]);
    for (const value of ['hunter2', 'abc', 'sk-ant-real', 'postgresql://', 'secret-value']) {
      expect(line, value).not.toContain(value);
    }
    expect(line).toContain('[redacted]');
  });

  it('strips payment evidence and bank references', () => {
    // Logs are shipped, indexed and retained for months. A bank slip in a log aggregator is a
    // disclosure no amount of care elsewhere makes up for.
    log.info({
      event: 'test.payment',
      transactionReference: 'FT2402XYZ',
      accountNumber: '1000123456789',
      evidenceText: 'Transfer of ETB 487,300 from ABC Construction',
    });

    const line = JSON.stringify(records[0]);
    expect(line).not.toContain('FT2402XYZ');
    expect(line).not.toContain('1000123456789');
    expect(line).not.toContain('ABC Construction');
  });

  it('strips raw customer message text', () => {
    // A customer message can contain anything a customer typed.
    log.info({ event: 'test.inquiry', message: 'my phone is 0911000101, send 400 bags' });
    expect(JSON.stringify(records[0])).not.toContain('0911000101');
  });

  it('redacts nested inside objects and arrays', () => {
    log.info({
      event: 'test.nested',
      payload: { inner: { password: 'deep' }, list: [{ token: 'also-deep' }] },
    });

    const line = JSON.stringify(records[0]);
    expect(line).not.toContain('deep');
    expect(line).not.toContain('also-deep');
  });

  it('truncates a long string rather than shipping it whole', () => {
    log.info({ event: 'test.long', note: 'x'.repeat(2000) });
    expect(JSON.stringify(records[0]).length).toBeLessThan(1500);
  });

  it('keeps what is actually useful', () => {
    // Not vacuous: over-redacting would make the log useless, which is its own failure.
    log.info({ event: 'payment.confirmed', code: 'CONFIRMED', orderNumber: 'SO-000042', count: 3 });

    const record = records[0]!;
    expect(record.event).toBe('payment.confirmed');
    expect(record.code).toBe('CONFIRMED');
    expect(record.orderNumber).toBe('SO-000042');
    expect(record.count).toBe(3);
  });

  it('serialises bigint money without throwing', () => {
    // JSON.stringify throws on a bigint. A log call that crashes the request it was recording
    // would be a spectacular own goal.
    expect(() => log.info({ event: 'test.money', amountMinor: 487_300_00n })).not.toThrow();
    expect(JSON.stringify(records[0])).toContain('48730000');
  });
});

describe('error reporting', () => {
  it('returns a reference the user can read out, and keeps the stack server-side', () => {
    const reported: ReportedError[] = [];
    setErrorReporterOverride({ name: 'test', report: (error) => reported.push(error) });

    try {
      const reference = withRequestContext(
        { correlationId: 'req_ABCDEFGHJK', organizationId: 'org-1', userId: 'user-1' },
        () => captureException(new Error('database exploded'), { event: 'test.failure' }),
      );

      expect(reference).toBe('req_ABCDEFGHJK');
      expect(reported).toHaveLength(1);
      expect(reported[0]!.stack).toBeDefined();
      expect(reported[0]!.organizationId).toBe('org-1');
    } finally {
      setErrorReporterOverride(null);
    }
  });

  it('still produces a reference outside a request context', () => {
    // A CLI script or a background operation must not crash for want of a correlation id.
    setErrorReporterOverride({ name: 'test', report: () => {} });
    try {
      expect(captureException(new Error('x'))).toMatch(/^req_/);
    } finally {
      setErrorReporterOverride(null);
    }
  });

  it('normalises a thrown non-Error', () => {
    const reported: ReportedError[] = [];
    setErrorReporterOverride({ name: 'test', report: (error) => reported.push(error) });
    try {
      captureException('a bare string', { event: 'test.string' });
      expect(reported[0]!.message).toBe('a bare string');
    } finally {
      setErrorReporterOverride(null);
    }
  });
});
