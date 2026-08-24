import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSink,
  TelegramSink,
  WebhookSink,
  configuredDestinations,
  type Alert,
} from '../../scripts/alert-sinks';

/**
 * The alert path, proven against a real HTTP server rather than a mock.
 *
 * This is the code that runs on the worst night the pilot has. Its failure mode is silence, and
 * silence is indistinguishable from "nothing went wrong" — so every claim about it has to be
 * demonstrated rather than asserted.
 */

/*
 * Deliberately NOT shaped like a real bot token.
 *
 * Telegram's format is <digits>:<35 chars>, and a fixture in that shape is what credential
 * scanners — GitHub's push protection included — are built to catch. The assertions below care
 * only that the value appears as a path segment and never in anything printed, so the shape buys
 * nothing and costs a blocked push.
 */
const TOKEN = 'test-bot-token-not-a-real-telegram-credential';
const CHAT = '-1001234567890';

const alert: Alert = {
  severity: 'critical',
  title: 'Database backup FAILED',
  detail: 'pg_dump exit 1 — could not connect to server: Connection refused (10.0.0.4:5432)',
  environment: 'staging',
  at: '2026-08-24T02:00:00.000Z',
};

let server: Server | null = null;

async function listen(handler: (body: string, url: string) => { status: number; json: unknown }) {
  const received: { body: string; url: string; contentType?: string }[] = [];

  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({
        body,
        url: request.url ?? '',
        contentType: request.headers['content-type'],
      });
      const result = handler(body, request.url ?? '');
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.json));
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return { received, base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('the Telegram sink', () => {
  it('sends what the Bot API actually requires', async () => {
    const { received, base } = await listen(() => ({
      status: 200,
      json: { ok: true, result: { message_id: 42 } },
    }));

    const result = await new TelegramSink(TOKEN, CHAT, base).deliver(alert);

    expect(result.delivered).toBe(true);

    const request = received[0]!;
    // The token is a path segment, which is exactly why this cannot reuse ALERT_WEBHOOK_URL.
    expect(request.url).toBe(`/bot${TOKEN}/sendMessage`);

    const body = JSON.parse(request.body) as Record<string, unknown>;
    // The field the generic webhook sink has nowhere to put, and without which Telegram refuses.
    expect(body.chat_id).toBe(CHAT);
    expect(String(body.text)).toContain('Database backup FAILED');
    expect(String(body.text)).toContain('staging');

    /*
     * No parse_mode. The detail line above contains `_`, `-`, `.`, `(` and `)`, every one of
     * which is a MarkdownV2 metacharacter that Telegram rejects with a 400 when unescaped. An
     * alert that fails to send because a hyphen appeared in an error message is worse than an
     * alert without bold text.
     */
    expect(body.parse_mode).toBeUndefined();
  });

  it('treats an ok:false body as a failure, whatever the status says', async () => {
    // Belt and braces: if Telegram ever answers 200 with a rejection, reporting that as
    // delivered would be the one lie this script must never tell.
    const { base } = await listen(() => ({
      status: 200,
      json: { ok: false, error_code: 400, description: 'chat not found' },
    }));

    const result = await new TelegramSink(TOKEN, CHAT, base).deliver(alert);

    expect(result.delivered).toBe(false);
    expect(result.note).toContain('chat not found');
  });

  it('reports a rejection with Telegram’s own reason', async () => {
    const { base } = await listen(() => ({
      status: 403,
      json: { ok: false, error_code: 403, description: 'bot was blocked by the user' },
    }));

    const result = await new TelegramSink(TOKEN, CHAT, base).deliver(alert);

    expect(result.delivered).toBe(false);
    expect(result.note).toContain('bot was blocked by the user');
  });

  it('never puts the bot token in anything it reports', async () => {
    const { base } = await listen(() => ({ status: 200, json: { ok: true } }));

    const delivered = await new TelegramSink(TOKEN, CHAT, base).deliver(alert);
    const rejected = await new TelegramSink(TOKEN, CHAT, 'http://127.0.0.1:1').deliver(alert);

    /*
     * `destination` and `note` are printed into cron output, evidence reports and the launch
     * gate. A bot token that reaches any of those is a bot token that has to be rotated, and
     * the failure paths are the ones that usually leak — an exception message tends to carry
     * the URL that produced it.
     */
    for (const result of [delivered, rejected]) {
      expect(result.destination).not.toContain(TOKEN);
      expect(result.note).not.toContain(TOKEN);
      expect(result.destination).not.toContain('api.telegram.org');
      expect(JSON.stringify(result)).not.toContain('not-a-real-telegram-credential');
    }

    // Enough to tell two configured chats apart, and no more.
    expect(delivered.destination).toBe('telegram (chat …7890)');
  });

  it('truncates rather than letting Telegram reject an oversized message', async () => {
    const { received, base } = await listen(() => ({ status: 200, json: { ok: true } }));

    await new TelegramSink(TOKEN, CHAT, base).deliver({
      ...alert,
      detail: 'x'.repeat(10_000),
    });

    const body = JSON.parse(received[0]!.body) as { text: string };
    expect(body.text.length).toBeLessThanOrEqual(4_096);
  });
});

describe('the webhook sink', () => {
  it('sends a shape Slack and a structured receiver can both read', async () => {
    const { received, base } = await listen(() => ({ status: 200, json: { ok: true } }));

    const result = await new WebhookSink(base).deliver(alert);

    expect(result.delivered).toBe(true);
    const body = JSON.parse(received[0]!.body) as Record<string, unknown>;
    expect(String(body.text)).toContain('Database backup FAILED');
    expect(body.severity).toBe('critical');
    expect(body.environment).toBe('staging');
  });

  it('reports the host and never the full URL, because the path carries the secret', async () => {
    const { base } = await listen(() => ({ status: 200, json: { ok: true } }));
    const secretPath = `${base}/services/T000/B111/XXXXsecretXXXX`;

    const result = await new WebhookSink(secretPath).deliver(alert);

    expect(result.destination).not.toContain('XXXXsecretXXXX');
    expect(result.destination).toContain('127.0.0.1');
  });
});

describe('which destinations are configured', () => {
  it('always includes the local file, so an alert is never lost entirely', () => {
    expect(configuredDestinations({} as NodeJS.ProcessEnv)).toEqual(['file']);
  });

  it('adds Telegram only when both halves are present', () => {
    expect(
      configuredDestinations({ TELEGRAM_BOT_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv),
    ).toEqual(['file']);

    expect(
      configuredDestinations({
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_CHAT_ID: CHAT,
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual(['file', 'telegram']);
  });
});

describe('the file sink', () => {
  it('writes one JSON line per alert', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const directory = await mkdtemp(join(tmpdir(), 'alerts-'));
    const path = join(directory, 'alerts.log');

    const result = await new FileSink(path).deliver(alert);

    expect(result.delivered).toBe(true);
    const written = JSON.parse((await readFile(path, 'utf8')).trim()) as Alert;
    expect(written.title).toBe('Database backup FAILED');
  });
});
