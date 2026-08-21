import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from './client';

/**
 * Tenant scoping.
 *
 * Layer 1 of the three described in architecture-baseline.md 7.1. A Prisma client extension
 * intercepts every operation on every organization-owned model and injects the organization
 * filter — into the `where` of reads, updates and deletes, and into the `data` of writes.
 * Forgetting to scope a query is therefore not a thing a developer can do; the filter is not
 * theirs to remember.
 *
 * Layer 2 is Row-Level Security in the database, activated by the session variable set in
 * `withTenant()`. Layer 3 is `tests/tenancy/`, which asserts both of the above rather than
 * trusting them.
 *
 * The one deliberate asymmetry: a query that *explicitly* names a different organization is
 * treated as an error rather than silently rewritten. Silent rewriting would turn an attack,
 * or a bug, into a query that quietly returns the wrong rows.
 */

/**
 * Models carrying an `organizationId` column.
 *
 * This list is not maintained by hand-discipline: `tests/tenancy/schema-coverage.test.ts`
 * reads the Prisma DMMF, finds every model with an `organizationId` field, and fails if one is
 * missing from this set. A model added in Phase 5 cannot silently opt out of tenancy.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'OrganizationSettings',
  'Membership',
  'Session',
  'Customer',
  'Product',
  'ProductAlias',
  'StockAdjustment',
  'AuditEvent',
  'NumberSequence',
  // Phase 2
  'Inquiry',
  'InquiryItemProposal',
  'AiInteraction',
  // Phase 3
  'Quotation',
  'QuotationItem',
  'QuotationApproval',
]);

/**
 * Models that are global on purpose, with the reason recorded. A model belongs here only if
 * it genuinely holds no tenant data — the coverage test consults this list, so adding a model
 * here is a visible decision rather than an omission.
 */
export const INTENTIONALLY_GLOBAL_MODELS: Readonly<Record<string, string>> = {
  Organization: 'the tenant itself; scoped by its own id, not by an organizationId column',
  User: 'a person, global by design; all authority comes from an organization-scoped Membership',
};

/**
 * Scoped by the extension, but deliberately *not* by Row-Level Security.
 *
 * Authentication necessarily runs before an organization is known: someone types an email
 * address, and the tenant can only be chosen once their password has verified and their
 * memberships have been read. A fail-closed RLS policy on these two tables would make login
 * impossible, because at that moment `app.organization_id` is not yet set and cannot be.
 *
 * They are still tenant-scoped by layer 1 for every query made after login, and they hold no
 * business data — a membership is a role, a session is a token hash and an expiry. The
 * exception is recorded here rather than left as a gap in the migration, so that
 * `tests/tenancy/schema-coverage.test.ts` can assert this exact partition and fail if a
 * *business* table ever drifts into it.
 */
export const EXTENSION_SCOPED_ONLY_MODELS: Readonly<Record<string, string>> = {
  Membership:
    'read during login to choose a tenant, before app.organization_id can possibly be set',
  Session: 'looked up by token hash on every request, before the organization is known',
};

export class CrossTenantAccessError extends Error {
  constructor(model: string, requested: string, allowed: string) {
    super(
      `refusing a ${model} query scoped to organization ${requested} from a session for ${allowed}`,
    );
    this.name = 'CrossTenantAccessError';
  }
}

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'upsert']);

type UnknownRecord = Record<string, unknown>;

function scopeField(model: string): string {
  // The Organization row is its own tenant boundary: it is filtered by primary key.
  return model === 'Organization' ? 'id' : 'organizationId';
}

function assertMatches(model: string, existing: unknown, organizationId: string): void {
  if (typeof existing === 'string' && existing !== organizationId) {
    throw new CrossTenantAccessError(model, existing, organizationId);
  }
}

function injectWhere(model: string, where: unknown, organizationId: string): UnknownRecord {
  const field = scopeField(model);
  const current = (where ?? {}) as UnknownRecord;
  assertMatches(model, current[field], organizationId);
  return { ...current, [field]: organizationId };
}

function injectData(model: string, data: unknown, organizationId: string): unknown {
  const field = scopeField(model);
  if (Array.isArray(data)) {
    return data.map((row) => injectData(model, row, organizationId));
  }
  const current = (data ?? {}) as UnknownRecord;
  assertMatches(model, current[field], organizationId);
  // Organization rows are created with an explicit id by the seed; nothing else creates them.
  if (field === 'id' && current.id === undefined) return current;
  return { ...current, [field]: organizationId };
}

/**
 * Builds the scoping extension for one organization. Cheap to construct — it is a proxy, not
 * a connection — so a fresh one per request is the intended usage.
 */
export function tenantExtension(organizationId: string) {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_SCOPED_MODELS.has(model) && model !== 'Organization') {
            return query(args);
          }

          const next = { ...(args as UnknownRecord) };

          if (WHERE_OPERATIONS.has(operation)) {
            next.where = injectWhere(model, next.where, organizationId);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            if (operation === 'upsert') {
              next.create = injectData(model, next.create, organizationId);
              next.update = next.update ?? {};
            } else {
              next.data = injectData(model, next.data, organizationId);
            }
          }

          return query(next);
        },
      },
    },
  });
}

/** A Prisma client that can only see one organization's rows. */
export type TenantClient = ReturnType<typeof tenantClient>;

export function tenantClient(organizationId: string) {
  return prisma.$extends(tenantExtension(organizationId));
}

/** A transaction handle carrying the same scoping. */
export type TenantTransaction = Omit<
  TenantClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction scoped to one organization.
 *
 * Two things happen before `fn` sees the handle:
 *
 *   1. `app.organization_id` is set for the duration of the transaction, which is what the
 *      RLS policies read. `set_config(..., true)` is transaction-local, so it cannot leak to
 *      the next borrower of the pooled connection.
 *   2. The handle is scoped by the extension above.
 *
 * Every mutation goes through here, because this is also where the audit log gets to share a
 * transaction with the change it records.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new Error(`withTenant() requires a UUID organization id, received "${organizationId}"`);
  }

  const client = tenantClient(organizationId);
  return client.$transaction(async (tx) => {
    // Parameterised: the id never becomes part of the SQL text.
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx as unknown as TenantTransaction);
  });
}
