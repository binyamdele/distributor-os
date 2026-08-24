/**
 * Where an operational alert goes.
 *
 * Phase 9 had one hard-coded webhook shape. Telegram does not fit it, and the reason is worth
 * recording rather than working around:
 *
 *   - `sendMessage` **requires a `chat_id`**. The generic sink posts `{text, ...alert}` and has
 *     nowhere to put one, so an authenticated request would be rejected for a missing field.
 *   - The bot token lives in the *path* of the request URL. Reusing `ALERT_WEBHOOK_URL` would
 *     mean storing a bot token in a variable that gets pasted into runbooks and issue reports,
 *     and whose host is printed in output.
 *
 * So Telegram gets an adapter, and the seam gets a name. Each sink is responsible for its own
 * request shape, its own success test, and — most importantly — for describing itself in a way
 * that is safe to print: `DeliveryResult.destination` and `.note` end up in evidence reports and
 * cron logs, so neither may ever contain a token, a full URL or a recipient address.
 */

export type Severity = 'critical' | 'warning' | 'info';

export interface Alert {
  readonly severity: Severity;
  readonly title: string;
  readonly detail?: string;
  readonly environment: string;
  readonly at: string;
}

export interface DeliveryResult {
  readonly destination: string;
  readonly delivered: boolean;
  /** Safe to print: never a URL, a token or a recipient address. */
  readonly note: string;
}

export interface AlertSink {
  readonly name: string;
  deliver(alert: Alert): Promise<DeliveryResult>;
}

const EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟠',
  info: '🔵',
};

/** The host only. A webhook URL embeds a secret token in its path. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function plainText(alert: Alert): string {
  return (
    `${EMOJI[alert.severity]} ${alert.severity.toUpperCase()} — ${alert.title}\n` +
    `Environment: ${alert.environment}\n` +
    `At: ${alert.at}` +
    (alert.detail ? `\n\n${alert.detail}` : '')
  );
}

// ---------------------------------------------------------------------------

/**
 * Appends to a local file, always, before anything remote is attempted.
 *
 * The fallback-of-record. If the network is down — entirely possible during the incident being
 * reported — the alert still lands somewhere durable rather than evaporating with it.
 */
export class FileSink implements AlertSink {
  readonly name = 'file';

  constructor(private readonly path: string) {}

  async deliver(alert: Alert): Promise<DeliveryResult> {
    const { appendFileSync, existsSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');

    try {
      const directory = dirname(this.path);
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

      appendFileSync(this.path, `${JSON.stringify(alert)}\n`, 'utf8');
      return { destination: 'file', delivered: true, note: this.path };
    } catch (error) {
      return {
        destination: 'file',
        delivered: false,
        note: error instanceof Error ? error.name : 'write failed',
      };
    }
  }
}

/** Slack, Discord, Google Chat, Teams, or anything that accepts a JSON POST. */
export class WebhookSink implements AlertSink {
  readonly name = 'webhook';

  constructor(private readonly url: string) {}

  async deliver(alert: Alert): Promise<DeliveryResult> {
    const destination = `webhook (${safeHost(this.url)})`;

    const text =
      `${EMOJI[alert.severity]} *${alert.severity.toUpperCase()}* — ${alert.title}\n` +
      `Environment: ${alert.environment}\n` +
      `At: ${alert.at}` +
      (alert.detail ? `\n${alert.detail}` : '');

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Both shapes in one payload: Slack and Google Chat read `text`, most other receivers
        // read the structured fields. One destination configuration works for either.
        body: JSON.stringify({ text, ...alert }),
        signal: AbortSignal.timeout(10_000),
      });

      return { destination, delivered: response.ok, note: `HTTP ${response.status}` };
    } catch (error) {
      return {
        destination,
        delivered: false,
        note: error instanceof Error ? error.name : 'request failed',
      };
    }
  }
}

/** Telegram caps a message at 4096 characters and rejects anything longer outright. */
const TELEGRAM_LIMIT = 4_000;

export class TelegramSink implements AlertSink {
  readonly name = 'telegram';

  /**
   * `apiBase` exists so this adapter can be proven against a local receiver.
   *
   * The webhook sink was verifiable from the start — point it at localhost and watch the request
   * arrive. Telegram's endpoint is fixed, so without a seam the only way to test the adapter is
   * to own a bot, and "it will presumably work" is how an alerting path stays unverified until
   * the night it matters. It defaults to the real API and is not read from the environment in
   * normal use.
   */
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly apiBase = 'https://api.telegram.org',
  ) {}

  /**
   * `telegram (chat …1234)`.
   *
   * The chat id is not a secret in the way the token is, but it identifies a specific person or
   * channel and this string is printed into cron output and evidence reports. The last four
   * digits are enough to tell two configured destinations apart, which is the only reason to
   * print any of it.
   */
  private get destination(): string {
    const tail = this.chatId.slice(-4);
    return `telegram (chat …${tail})`;
  }

  async deliver(alert: Alert): Promise<DeliveryResult> {
    let text = plainText(alert);
    if (text.length > TELEGRAM_LIMIT) text = `${text.slice(0, TELEGRAM_LIMIT)}…`;

    try {
      const response = await fetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          /*
           * No `parse_mode`, deliberately.
           *
           * Telegram's MarkdownV2 requires backslash-escaping of `_ * [ ] ( ) ~ \` > # + - = | { }
           * . !` — and an unescaped one is a 400, not a formatting glitch. Alert detail lines
           * carry file paths, exit codes, timestamps and pg_dump output, which are full of
           * exactly those characters. An alert that fails to send because a hyphen appeared in
           * an error message is worse than an alert without bold text.
           */
          disable_notification: alert.severity === 'info',
        }),
        signal: AbortSignal.timeout(10_000),
      });

      /*
       * Both the HTTP status and the body's own `ok` field.
       *
       * Telegram signals failure with a non-2xx status *and* an `ok: false` body. Checking both
       * costs one JSON parse and means a future change to either convention cannot turn a failed
       * delivery into a reported success — which is the one lie this script must never tell.
       */
      let acknowledged = false;
      try {
        const body = (await response.json()) as { ok?: boolean; description?: string };
        acknowledged = body.ok === true;
        if (!acknowledged) {
          return {
            destination: this.destination,
            delivered: false,
            // Telegram's own description ("chat not found", "bot was blocked by the user") is
            // the single most useful thing here and contains no secret.
            note: `HTTP ${response.status}: ${body.description ?? 'rejected'}`,
          };
        }
      } catch {
        return {
          destination: this.destination,
          delivered: false,
          note: `HTTP ${response.status}: unreadable response`,
        };
      }

      return {
        destination: this.destination,
        delivered: response.ok && acknowledged,
        note: `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        destination: this.destination,
        delivered: false,
        note: error instanceof Error ? error.name : 'request failed',
      };
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Every sink the environment has configured, file first.
 *
 * File first is not cosmetic: `notify()` delivers in this order, so the durable copy is written
 * before any network call that might hang or fail.
 */
export function configuredSinks(env: NodeJS.ProcessEnv = process.env): AlertSink[] {
  const sinks: AlertSink[] = [new FileSink(env.ALERT_LOG_PATH ?? './backups/alerts.log')];

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (token && chatId) sinks.push(new TelegramSink(token, chatId));

  const webhook = env.ALERT_WEBHOOK_URL;
  if (webhook) sinks.push(new WebhookSink(webhook));

  return sinks;
}

/**
 * Which alert destinations are configured, without saying anything about their values.
 *
 * For the launch gate and for `ops:verify-deployment`: "is a human-visible destination wired up"
 * is a question that has to be answerable in a report that contains no secrets.
 */
export function configuredDestinations(env: NodeJS.ProcessEnv = process.env): string[] {
  return configuredSinks(env).map((sink) => sink.name);
}
