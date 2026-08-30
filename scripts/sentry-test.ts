/**
 * Sends exactly one synthetic event to the configured Sentry project, and says whether it landed.
 *
 * The counterpart to `ops:notify --test`, and it exists for the same reason: an error-reporting
 * path that has never delivered anything is a belief, not a capability. The failure mode is
 * silence — a DSN with a typo, a project that was deleted, an egress rule — and silence is
 * indistinguishable from "nothing has gone wrong yet" until the night something does.
 *
 * It goes through **the application's own reporter**, obtained from `errorReporter()`, so what is
 * proved is the path production uses: the same DSN parsing, the same envelope, the same auth
 * header, and the same `scrub()` applied to the message. A `curl` to the ingest endpoint would
 * prove only that curl works.
 *
 * Usage:
 *   pnpm ops:sentry-test
 */
import { config as loadEnv } from 'dotenv';
import { config } from '../src/platform/config';
import { errorReporter } from '../src/platform/observability/errors';
import { SentryErrorReporter } from '../src/platform/observability/sentry';

loadEnv();

/**
 * A recognisable message, carrying a deliberately secret-shaped token.
 *
 * The token is synthetic and is here to be *removed*: it is long enough to trip `scrub()`'s
 * opaque-run rule, so the event that arrives in Sentry should read `[redacted]` in its place.
 * That turns "scrubbing is applied" from a claim into something the operator can see in the UI.
 */
const SYNTHETIC_TOKEN = 'synthetic_token_for_scrub_test_0000000000';
const MESSAGE =
  'Distributor OS Sentry verification test — deliberate synthetic event, no action needed. ' +
  `Scrub check, this must not appear: ${SYNTHETIC_TOKEN}`;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const settings = config();

  if (!settings.ERROR_REPORTING_DSN) {
    /*
     * The most likely misconfiguration, and it is silent.
     *
     * `SENTRY_DSN` is what Sentry's own documentation and most platform integrations call this,
     * so it is the natural thing for an operator to set — and this application does not read it.
     * With neither set, reports go to the log and nothing anywhere says Sentry is not wired up.
     */
    const looksLikeTheWrongName = Boolean(process.env.SENTRY_DSN);

    fail(
      'No ERROR_REPORTING_DSN is set, so exceptions are logged only and nothing reaches Sentry.' +
        (looksLikeTheWrongName
          ? '\n\nSENTRY_DSN *is* set. This application reads ERROR_REPORTING_DSN — the setting is\n' +
            'named for the seam rather than the vendor, so swapping providers does not mean\n' +
            'renaming a variable. Set ERROR_REPORTING_DSN to the same value.'
          : '\n\nSet ERROR_REPORTING_DSN to the project DSN and run this again.'),
    );
  }

  const reporter = errorReporter();

  if (!(reporter instanceof SentryErrorReporter)) {
    fail(
      `ERROR_REPORTING_DSN is set but did not parse as a Sentry DSN, so the active reporter is\n` +
        `"${reporter.name}" and events are logged only. A Sentry DSN looks like\n` +
        'https://<key>@<org>.ingest.sentry.io/<project>.',
    );
  }

  const correlationId = `req_SENTRYTEST_${Date.now().toString(36).toUpperCase()}`;

  console.log('');
  console.log('  Sending one synthetic event to Sentry.');
  console.log(`  environment   ${settings.APP_ENV}`);
  console.log(`  release       ${settings.BUILD_SHA}`);
  console.log(`  correlation   ${correlationId}`);
  console.log('');

  /*
   * `deliver`, not `report`.
   *
   * They are the same transport — `report` calls this and discards the result, because reporting
   * an error must never depend on telemetry succeeding. A verification command is the one place
   * that wants the opposite: it needs the answer, so it can exit non-zero when Sentry refuses.
   */
  const outcome = await reporter.deliver({
    correlationId,
    event: 'ops.sentry_verification',
    message: MESSAGE,
    // No stack, no organization, no user: this is a synthetic event and has no incident behind it.
  });

  console.log(`  event id      ${outcome.eventId}`);
  // Host only. The DSN's userinfo is its public key and never appears in output.
  console.log(`  destination   ${outcome.host}`);
  console.log(
    `  response      ${outcome.status ? `HTTP ${outcome.status}` : (outcome.reason ?? '—')}`,
  );
  console.log('');

  if (!outcome.accepted) {
    fail(
      'Sentry did not accept the event.\n' +
        (outcome.status === 401 || outcome.status === 403
          ? 'That status means the DSN key was rejected — check it belongs to this project.'
          : outcome.status === 429
            ? 'That status means the project is rate-limited or over quota.'
            : 'Check the DSN, the project, and whether this host can reach Sentry at all.'),
    );
  }

  console.log('  Accepted. Find it in Sentry by searching the event id above, or for');
  console.log('  "Distributor OS Sentry verification test".');
  console.log('');
  console.log('  Two things to confirm in the UI, because they are the point of the test:');
  console.log(`    - environment is "${settings.APP_ENV}" and release is the deployed commit`);
  console.log('    - the message shows [redacted] where a token-shaped string was sent');
  console.log('');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
