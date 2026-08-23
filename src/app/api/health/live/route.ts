import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness. Deliberately checks nothing.
 *
 * If this touched the database, a database blip would make an orchestrator kill and restart
 * every healthy container — turning a recoverable dependency outage into a restart storm at the
 * worst possible moment. The only question here is whether the process can still answer.
 */
export function GET(): Response {
  return NextResponse.json({ status: 'alive' }, { headers: { 'cache-control': 'no-store' } });
}
