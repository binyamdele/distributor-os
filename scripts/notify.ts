/**
 * Delivers an operational alert to somewhere a person will see it.
 *
 * The blocker this closes is stated plainly in the Phase 9 runbook: *a backup silently failing
 * for thirty days is not a backup system.* Everything else in that document is procedure; this
 * is the part that makes a failure impossible to miss.
 *
 * The destinations live in `alert-sinks.ts`. Every configured one is attempted, the local file
 * first and always, and every attempt is reported — because an evidence report has to be able to
 * say which destinations actually received the alert, not merely that one of them did.
 *
 * Usage:
 *   pnpm ops:notify --severity critical --title "Backup failed" --detail "pg_dump exit 1"
 *   pnpm ops:notify --test
 */
import { config as loadEnv } from 'dotenv';
import { configuredSinks } from './alert-sinks';
import type { Alert, DeliveryResult, Severity } from './alert-sinks';

loadEnv();

export type { Alert, DeliveryResult, Severity } from './alert-sinks';

/**
 * Sends an alert everywhere that is configured.
 *
 * Sequential rather than concurrent, so the durable local copy is written before any network
 * call that might hang. The whole set is bounded by each sink's own timeout.
 */
export async function notify(alert: Alert): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (const sink of configuredSinks()) {
    results.push(await sink.deliver(alert));
  }
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

  const human = results.filter((result) => result.destination !== 'file');
  if (human.length === 0) {
    console.log('');
    console.log('  No human-visible destination is configured, so the alert was written locally');
    console.log('  only. A log file nobody opens is not an alert. Set TELEGRAM_BOT_TOKEN and');
    console.log('  TELEGRAM_CHAT_ID, or ALERT_WEBHOOK_URL: docs/operational-alerts.md.');
  } else if (!human.some((result) => result.delivered)) {
    console.log('');
    console.log('  Every human-visible destination FAILED. The local copy is all that exists.');
  }
  console.log('');

  /*
   * Zero only if a person was actually told.
   *
   * The old rule — "zero if anything at all got through" — was satisfied by the local file
   * write, which always succeeds. So `pnpm ops:notify --test` passed on a machine with no
   * destination configured at all, which is exactly the state the test exists to detect. A test
   * that cannot fail is not a test.
   */
  // exitCode rather than exit(): see the comment in check-readiness.ts — exiting immediately
  // after an HTTP request aborts the process on Windows and replaces the exit code with noise.
  process.exitCode = human.some((result) => result.delivered) ? 0 : 1;
}

// Only when invoked directly, so `notify()` can be imported by the backup script.
if (process.argv[1]?.includes('notify')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
