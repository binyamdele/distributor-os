# Phase 9 — Operational Readiness Baseline

Written **before** any Phase 9 code, from an inspection of the repository at `0174d3a`. It
records what the eight development phases already made production-capable, what still quietly
assumes a laptop, and what has to change before a real distributor's business runs on this.

The distinction that matters throughout: the application is *feature-complete against the brief*
and is *not operable*. Those are different claims, and only the first one has been earned so far.

---

## 1. What is already production-capable

These were built as production concerns from the start and need no rework.

| Area | Evidence |
|---|---|
| **Two database roles** | `DATABASE_URL` connects as `distributor_app` (NOSUPERUSER); `DIRECT_URL` connects as the owner and is used only by `prisma migrate`. The application never holds migration privileges. |
| **Row-Level Security** | `ENABLE` + `FORCE` on every business table, with the `nullif(current_setting(...), '')::uuid` predicate that fails closed on a pooled connection. Real because the app role is not a superuser. |
| **Tenancy in depth** | Prisma extension injects `organizationId`; RLS backs it; `tests/tenancy/` asserts both against the DMMF so a new table cannot silently opt out. |
| **Password hashing** | scrypt (N=2¹⁵, r=8), parameters encoded in the stored hash so they can be raised without invalidating credentials. Node stdlib — no native module, no compiler on the pilot machine. |
| **Session cookies** | `httpOnly`, `SameSite=Lax`, `secure` under `NODE_ENV=production`, server-side expiry re-checked on every request, revoked on logout. |
| **Config validation** | Zod schema, parsed once, throws on invalid input. Already refuses `AI_PROVIDER=anthropic` with an empty key. |
| **Evidence storage** | Files outside the web root under store-invented keys; the `FileStore` interface has **no URL method**; the only read path is an authenticated, permission-checked, tenant-scoped route where a foreign id, a malformed id and a nonexistent id all return the same 404. |
| **Append-only history** | `REVOKE UPDATE, DELETE` on `audit_events` and `inventory_movements`; triggers making confirmed payments, consumed reservations and resolved discrepancies immutable. |
| **Money and time** | Integer minor units throughout; reporting boundaries computed in the organization's timezone. |
| **Test depth** | 1,334 vitest (878 unit, 456 integration against real PostgreSQL 17) and 174 Playwright specs. |

---

## 2. What currently assumes local development

| Assumption | Where |
|---|---|
| Postgres is a `docker-compose` container with the password `distributor` | `docker-compose.yml` |
| Evidence is written to `./storage` on the local filesystem | `FILE_STORAGE_DIR` default, `LocalFileStore` |
| The only way to create an organization is to edit and run `prisma/seed.ts` | `db:seed` |
| `db:reset` is `prisma migrate reset --force` with no guard on where it points | `package.json` |
| `NODE_ENV` has three values and there is no notion of *staging* | config schema |
| The app is started with `next start` by a developer | no process manager, no container image |
| Nothing is logged at all — there is not a single `console.*` in `src/` | verified by search |

---

## 3. Production blockers

Ordered by how much damage each would do on day one.

1. **The demo seed can be run against production.** `pnpm db:seed` reads `DIRECT_URL` and has no
   environment guard. Worse, `prisma/seed-fulfillment.ts` deliberately disables the
   consumed-reservation immutability trigger to reset demo data. That is correct for a demo and
   catastrophic as a production-reachable operation.
2. **`db:reset` is one mistyped environment away from destroying a distributor's business.**
3. **There is no way to create the first real organization** except editing a seed file that also
   creates fictional customers and fabricated prices.
4. **`AI_PROVIDER` defaults to `mock` and production would accept it silently.** A pilot could
   ship with a screen implying a model interpreted a customer's message when a rule-based stub
   did. The application must refuse this combination or label it unmistakably.
5. **No backup exists, and no restore has ever been attempted.** This is the single largest gap:
   every other item on this list is recoverable, and data loss is not.
6. **No health endpoint**, so a deploy platform has no way to know whether the app can serve
   traffic, and no external uptime check can be pointed anywhere meaningful.
7. **No object storage adapter.** Local disk does not survive a container restart on managed
   hosting, which would silently discard payment evidence.

---

## 4. Security blockers

1. **No rate limiting anywhere**, including login. A trivial script can attempt passwords at the
   speed of the network. scrypt makes each attempt expensive for the *server* as well, so this is
   also a denial-of-service vector.
2. **No secret-scanning check.** `.gitignore` is correct and `.env` is untracked, but nothing
   would catch a secret pasted into a source file or a doc.
3. **Unhandled server exceptions render Next.js's default error page.** In production that hides
   stack traces from users, but nothing scrubs or records what actually happened, so support has
   no way to trace a report back to an incident.
4. **The runtime role's grants have never been asserted in a test.** RLS is tested; "the app role
   is not a superuser and cannot bypass it" is currently a property of how the container happens
   to be provisioned rather than something pinned.
5. **No dependency audit has been run.**

---

## 5. Recoverability gaps

- No backup schedule, no retention, no encryption story, no ownership.
- **No restore has ever been rehearsed.** A backup that has not been restored is a hypothesis.
- Payment evidence lives outside PostgreSQL, so a database restore alone reconstitutes rows that
  point at files which may no longer exist. The `content_hash` column makes this *detectable*,
  and nothing currently detects it.
- No documented rollback policy. Prisma does not roll migrations back; pretending otherwise
  during an incident would be worse than having no policy.

---

## 6. Observability gaps

- No structured logging, no correlation IDs, no error reporting.
- No way to identify which commit is deployed — during a support call, "which version are you
  running" currently has no answer.
- No alerting definition.

---

## 7. Deployment options considered

| Option | Verdict |
|---|---|
| **Container image + managed Postgres + S3-compatible storage** | **Chosen.** Portable, runs on any host that takes a container, and keeps the two-role database model that RLS depends on. |
| Vercel + Neon/Supabase | Fast, but the serverless connection model fights the transaction-and-advisory-lock design that every concurrency guarantee in Phases 4–7 rests on. |
| VM with everything installed by hand | Cheapest, and makes the restore drill and the deploy runbook a person's memory rather than an artefact. |
| Kubernetes | An explicit Phase 9 non-goal, and correct: one pilot does not need an orchestrator. |

The pilot serves **one distributor in Addis Ababa**, so a single container instance against a
managed Postgres is the right size. The architecture stays portable because the only host-specific
pieces are the object store (behind the existing `FileStore` interface) and the database URL.

---

## 8. Proposed Phase 9 scope

Organised by whether it can be *proved here* or only *prepared here*. That distinction is stated
in the scorecard at the end of the phase rather than blurred.

### Provable in this environment
- Environment separation (`APP_ENV`) with production guards that fail at startup
- Config validation extended to every production setting
- Demo seed and destructive scripts refused outside development
- Admin provisioning CLI for the first organization and owner
- CSV import for customers, products and opening stock, with preview, all-or-nothing commit,
  idempotency by file fingerprint, and an `OPENING_BALANCE` inventory movement
- Health (`live` / `ready`) and version endpoints
- Structured logging, correlation IDs, safe user-facing errors
- Error-reporting adapter
- Rate limiting on login, AI parse, upload and extraction
- Database role and RLS-bypass assertions as tests
- Migration replay from zero against a fresh database
- **Backup and restore rehearsal with recorded evidence**, including evidence-file integrity
- Graceful shutdown, provider timeouts, pool configuration
- Moderate load test
- CI pipeline
- The full pilot flow end to end against a production-like configuration

### Prepared but not provable here
- **S3-compatible storage adapter.** Written against the existing `FileStore` interface and
  contract-tested against that interface. It cannot be verified against a live bucket from this
  environment, and the phase report will say so rather than implying otherwise.
- **The deployment itself.** A Dockerfile, a staging configuration and a runbook can be produced
  and reviewed; an actual cloud deploy cannot be performed here. "Deployable" and "deployed" are
  different claims and only the first will be made.
- **Scheduled backups and alert delivery.** The commands, retention policy and failure-visibility
  requirements are documented and the restore is rehearsed; the cron and the alert destination
  belong to whoever owns the production account.

### Explicitly out of scope
Everything in §53 of the brief — messaging, real payment integrations, OCR, forecasting,
procurement, route optimisation, accounting, native apps, multi-region, Kubernetes, Redis.

---

## 9. The honest summary

Eight phases built an application whose business logic is defensible: money is exact, tenancy is
enforced three ways, the AI cannot invent a price or a payment, and every consequential mutation
is audited and often immutable.

None of that survives a machine that dies without a backup. Phase 9's first duty is the restore
drill; everything else is second.
