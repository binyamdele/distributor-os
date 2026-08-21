import { NextResponse } from 'next/server';
import { currentSession } from '@/app/lib/session';
import { withTenant } from '@/platform/db';
import { evidenceForReading } from '@/modules/payments';
import { fileStore } from '@/platform/storage';
import { can } from '@/platform/rbac';

/**
 * The only way to read a piece of payment evidence.
 *
 * Nothing about a stored file is reachable without passing through here, and that is the point.
 * The bytes live outside the web root under a key the store invents, the row records the key but
 * never a URL, and no `getUrl` method exists on the store interface to be called by accident.
 *
 * Three checks, in this order, and none of them is optional:
 *
 *   1. **Signed in.** No session, no file. There is no unauthenticated path.
 *   2. **Permitted.** `read:payment` — held by finance and the owner, and by nobody in sales or
 *      the warehouse. A salesperson can attach a customer's bank slip and can never read one back.
 *   3. **In this tenant.** The lookup runs inside `withTenant`, so a file id belonging to another
 *      organization does not resolve. Possession of the identifier gets an attacker precisely
 *      nowhere: a valid id from the wrong tenant, a malformed id and an id that was never issued
 *      all produce the same 404, so the response cannot be used to confirm a file exists.
 *
 * The response is deliberately unhelpful to anything but a browser tab: no caching, no inline
 * rendering of arbitrary types, and no filename echoed back from what the customer uploaded.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) return new NextResponse('Not found', { status: 404 });
  if (!can(session.role, 'read:payment')) return new NextResponse('Not found', { status: 404 });

  const { id } = await params;

  const file = await withTenant(session.organizationId, (tx) => evidenceForReading(tx, id));
  if (!file.ok) return new NextResponse('Not found', { status: 404 });

  const bytes = await fileStore().read(file.value.storageKey);
  if (!bytes) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': file.value.mimeType,
      // `attachment` rather than `inline`: an uploaded file is never rendered as a document in
      // the application's own origin, which is what would turn a crafted upload into stored XSS.
      'Content-Disposition': `attachment; filename="evidence-${file.value.contentHash.slice(0, 12)}"`,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // Nothing in an uploaded file should ever execute or fetch.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
