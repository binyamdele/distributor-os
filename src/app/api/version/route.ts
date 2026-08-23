import { NextResponse } from 'next/server';
import { buildInfo } from '@/platform/observability';

export const dynamic = 'force-dynamic';

/**
 * What is deployed, for support.
 *
 * Version, commit and build time only. Safe: the repository is not public and a hash grants
 * nothing. Everything that would be genuinely useful to an attacker — connection strings, keys,
 * hostnames, the environment's other settings — is deliberately absent, because a diagnostics
 * endpoint that grows "just one more field" is how reconnaissance targets are built.
 */
export function GET(): Response {
  return NextResponse.json(buildInfo(), { headers: { 'cache-control': 'no-store' } });
}
