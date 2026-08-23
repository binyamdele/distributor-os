import { NextResponse } from 'next/server';
import { captureException, checkReadiness, log } from '@/platform/observability';

export const dynamic = 'force-dynamic';

/**
 * Readiness. Can this process serve business traffic?
 *
 * 200 when every hard dependency answers, 503 otherwise, so a load balancer takes an unhealthy
 * container out of rotation instead of letting it serve errors. The body names which check
 * failed and how long it took, and nothing else — no exception message, no host, no path.
 */
export async function GET(): Promise<Response> {
  try {
    const report = await checkReadiness();

    if (!report.ready) {
      log.warn({
        event: 'health.not_ready',
        failed: report.checks.filter((check) => check.status === 'failed').map((c) => c.name),
      });
    }

    return NextResponse.json(
      { status: report.ready ? 'ready' : 'not-ready', checks: report.checks },
      { status: report.ready ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    // A readiness probe that throws must still answer, or the platform cannot distinguish
    // "unhealthy" from "gone".
    const reference = captureException(error, { event: 'health.check_failed' });
    return NextResponse.json(
      { status: 'not-ready', reference },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
