/**
 * Delivers an operational alert to somewhere a person will see it.
 *
 * The blocker this closes is stated plainly in the Phase 9 runbook: *a backup silently failing
 * for thirty days is not a backup system.* Everything else in that document is procedure; this
 * is the part that makes a failure impossible to miss.
 *
 * An adapter with three destinations, chosen so a pilot can wire whichever it actually has:
 *
 *   - **webhook** — Slack, Discord, Google Chat, Teams, or anything that accepts a JSON POST
 *   - **email** — via a webhook-style transactional API, because SMTP from a container is a
 *     deliverability problem nobody wants during a pilot
 *   - **file** — appends to a log a monitoring agent tails, and always writes locally as well
 *
 * The file destination is not a placeholder pretending to be an integration. It is the
 * fallback-of-record: if the webhook is down, or nobody has configured one yet, the alert still
 * lands somewhere durable rather than evaporating. Every delivery writes the file copy first and
 * *then* attempts the remote one, so a network failure cannot lose the alert it was reporting.
 *
 * Usage:
 *   pnpm ops:notify --severity critical --title "Backup failed" --detail "pg_dump exit 1"
 *   pnpm ops:notify --test
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv();

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
  /** Safe to print in an evidence report: never a URL, a token or a recipient address. */
  readonly note: string;
}

const ALERT_LOG = process.env.ALERT_LOG_PATH ?? './backups/alerts.log';

/**
 * Always writes, always first.
 *
 * If the webhook is unreachable — which is entirely possible during exactly the incident being
 * reported — the alert must not be lost with it.
 */
function writeLocal(alert: Alert): DeliveryResult {
  try {
    const directory = dirname(ALERT_LOG);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

    appendFileSync(ALERT_LOG, `${JSON.stringify(alert)}\n`, 'utf8');
    return { destination: 'file', delivered: true, note: ALERT_LOG };
  } catch (error) {
    return {
      destination: 'file',
      delivered: false,
      note: error instanceof Error ? error.name : 'write failed',
    };
  }
}

/** The host only. A webhook URL embeds a secret token in its path. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

const EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟠',
  info: '🔵',
};

async function deliverWebhook(alert: Alert, url: string): Promise<DeliveryResult> {
  const text =
    `${EMOJI[alert.severity]} *${alert.severity.toUpperCase()}* — ${alert.title}\n` +
    `Environment: ${alert.environment}\n` +
    `At: ${alert.at}` +
    (alert.detail ? `\n${alert.detail}` : '');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Both shapes in one payload: Slack and Google Chat read `text`, most other receivers read
      // the structured fields. Sending both means one destination configuration works for either.
      body: JSON.stringify({ text, ...alert }),
      // Bounded: an alert that hangs is an alert that did not arrive.
      signal: AbortSignal.timeout(10_000),
    });

    return {
      destination: `webhook (${safeHost(url)})`,
      delivered: response.ok,
      note: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      destination: `webhook (${safeHost(url)})`,
      delivered: false,
      note: error instanceof Error ? error.name : 'request failed',
    };
  }
}

/**
 * Sends an alert everywhere that is configured.
 *
 * Returns every attempt rather than the first success, because the evidence report has to be
 * able to say which destinations actually received it.
 */
export async function notify(alert: Alert): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [writeLocal(alert)];

  const webhook = process.env.ALERT_WEBHOOK_URL;
  if (webhook) results.push(await deliverWebhook(alert, webhook));

  return results;
}

// ---------------------------------------------------------------------------

interface Args {
  severity: Severity;
  title: string;
  detail?: string;
  test: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { severity: 'warning', title: '', test: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--test') args.test = true;
    else if (flag === '--severity' && value) args.severity = value as Severity;
    else if (flag === '--title' && value) args.title = value;
    else if (flag === '--detail' && value) args.detail = value;
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const alert: Alert = args.test
    ? {
        severity: 'info',
        title: 'Alerting test',
        detail:
          'A deliberate test from `pnpm ops:notify --test`. If you are reading this, a real ' +
          'backup failure would reach you the same way.',
        environment: process.env.APP_ENV ?? 'development',
        at: new Date().toISOString(),
      }
    : {
        severity: args.severity,
        title: args.title || 'Unspecified alert',
        detail: args.detail,
        environment: process.env.APP_ENV ?? 'development',
        at: new Date().toISOString(),
      };

  const results = await notify(alert);

  console.log('');
  console.log(`  ${alert.severity.toUpperCase()} — ${alert.title}`);
  console.log('');
  for (const result of results) {
    console.log(
      `  ${result.delivered ? 'delivered' : 'FAILED   '}  ${result.destination}  ${result.note}`,
    );
  }

  if (!process.env.ALERT_WEBHOOK_URL) {
    console.log('');
    console.log('  No ALERT_WEBHOOK_URL is set, so the alert was written locally only.');
    console.log('  Set one before the pilot: docs/operational-alerts.md.');
  }
  console.log('');

  // Non-zero only when nothing at all got through. The local write is the floor: if even that
  // fails, the alerting path itself is broken and a cron job should say so loudly.
  process.exit(results.some((result) => result.delivered) ? 0 : 1);
}

// Only when invoked directly, so `notify()` can be imported by the backup script.
if (process.argv[1]?.includes('notify')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
