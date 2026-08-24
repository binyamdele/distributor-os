/**
 * Polls a deployment's readiness endpoint and alerts a person when it is not green.
 *
 * Three of the alerts the operational plan requires — readiness failing, the database
 * unreachable, evidence storage unreachable — are all answered by one endpoint that the
 * application already exposes. What was missing was anything that *looks* at it.
 *
 * Deliberately an external poller rather than something inside the application:
 *
 *   - a process cannot alert on being unable to start, or on having died
 *   - a process whose database is unreachable is in a poor position to do reliable work
 *   - readiness is already the contract a load balancer uses, so alerting on the same signal
 *     means the alert and the traffic decision cannot disagree
 *
 * Run it from somewhere that is not the application host. A monitor that shares a machine with
 * the thing it monitors goes down with it, and the failure it exists to catch is exactly that.
 *
 * Usage:
 *   pnpm ops:check-readiness --base-url https://pilot.example.com
 *   pnpm ops:check-readiness --base-url https://pilot.example.com --quiet-when-healthy
 */
import { config as loadEnv } from 'dotenv';
import { notify } from './notify';
import type { Severity } from './alert-sinks';

loadEnv();

interface Args {
  baseUrl: string;
  timeoutMs: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { baseUrl: '', timeoutMs: 15_000, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--base-url' && value) args.baseUrl = value.replace(/\/$/, '');
    else if (argv[index] === '--timeout-ms' && value) args.timeoutMs = Number(value);
    else if (argv[index] === '--quiet-when-healthy') args.quiet = true;
  }
  return args;
}

interface ReadyBody {
  status?: string;
  checks?: { name: string; status: string; latencyMs: number; detail?: string }[];
}

/**
 * What a failing check means to the person being woken.
 *
 * The mapping matters because it decides whether a phone rings. A database that cannot be
 * reached stops every workflow in the product; an evidence store that cannot be reached stops
 * payments, which is half of it. Both are worth waking somebody for. Anything else that fails is
 * still reported, but as a warning — the alert plan's governing rule is that an alert which
 * fires weekly and is dismissed weekly has trained somebody to dismiss it.
 */
const CRITICAL_CHECKS = new Set(['database', 'migrations', 'file-store']);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseUrl) {
    console.error('\n--base-url is required, e.g. --base-url https://pilot.example.com\n');
    process.exit(1);
  }

  const environment = process.env.APP_ENV ?? 'development';
  const at = new Date().toISOString();

  let severity: Severity | null = null;
  let title = '';
  let detail = '';

  try {
    const response = await fetch(`${args.baseUrl}/api/health/ready`, {
      signal: AbortSignal.timeout(args.timeoutMs),
      headers: { 'cache-control': 'no-cache' },
    });

    const body = (await response.json().catch(() => ({}))) as ReadyBody;
    const failing = (body.checks ?? []).filter((check) => check.status !== 'ok');

    if (response.ok && failing.length === 0) {
      if (!args.quiet) {
        console.log('');
        console.log(`  Readiness  green (${(body.checks ?? []).length} checks)`);
        for (const check of body.checks ?? []) {
          console.log(`    ok    ${check.name} — ${check.latencyMs}ms`);
        }
        console.log('');
      }
      return;
    }

    const named = failing.map((check) => `${check.name}: ${check.status}`).join(', ');
    const critical = failing.some((check) => CRITICAL_CHECKS.has(check.name));

    severity = critical || !response.ok ? 'critical' : 'warning';
    title = response.ok ? 'Readiness degraded' : 'Application NOT READY';
    detail =
      `HTTP ${response.status} from ${new URL(args.baseUrl).host}` +
      (named ? `\nFailing: ${named}` : '\nNo check detail in the response body.');
  } catch (error) {
    /*
     * Unreachable is its own failure, and a worse one.
     *
     * A 503 means the application answered and told the truth about itself. A timeout means
     * nobody answered at all — the process, the host or the network. That is the state where
     * silence is most likely to be mistaken for health.
     */
    severity = 'critical';
    title = 'Application unreachable';
    detail =
      `No response from ${new URL(args.baseUrl).host} within ${args.timeoutMs}ms ` +
      `(${error instanceof Error ? error.name : 'unknown'})`;
  }

  console.error('');
  console.error(`  ${severity.toUpperCase()} — ${title}`);
  console.error(`  ${detail.replace(/\n/g, '\n  ')}`);
  console.error('');

  const results = await notify({ severity, title, detail, environment, at });
  for (const result of results) {
    console.error(`  alert ${result.delivered ? 'delivered' : 'FAILED'}: ${result.destination}`);
  }
  console.error('');

  /*
   * `exitCode`, not `exit()`.
   *
   * `process.exit()` immediately after an HTTP request aborts the process on Windows —
   * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — and the shell then sees
   * 3221226505 instead of 1. A monitoring script whose exit code is garbage is a monitoring
   * script a scheduler cannot act on, which defeats the point of running it on a schedule.
   *
   * Setting the code and letting the event loop drain gives the socket time to close and exits
   * with exactly 1.
   */
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
