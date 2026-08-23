import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Assigns a correlation id to every request.
 *
 * Middleware runs on the Edge runtime, which has no `AsyncLocalStorage` and no Node crypto, so
 * this cannot use the correlation module directly. What it can do is put the id on a request
 * header, which the Node-side server code then picks up and installs into its own context — one
 * id for the whole request, generated once, at the earliest point that exists.
 *
 * It is echoed on the response too, so a browser's network tab and a support ticket can carry the
 * same reference the logs do.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `req_${out}`;
}

export function middleware(request: NextRequest): NextResponse {
  // An inbound value is never trusted: a client could otherwise choose an id and collide every
  // request with somebody else's, or inject control characters into a log line.
  const correlationId = newId();

  const headers = new Headers(request.headers);
  headers.set('x-correlation-id', correlationId);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('x-correlation-id', correlationId);
  return response;
}

export const config = {
  // Everything except static assets. Liveness is included deliberately: a probe that fails is
  // worth being able to trace like anything else.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
