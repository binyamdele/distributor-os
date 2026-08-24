# Pilot Launch Gate

The gates between here and a real distributor's data, and whether each is cleared.

**One BLOCKED item means: do not import real distributor data.**

No percentage. Each gate is VERIFIED or BLOCKED, with the evidence that decided it.

---

## Where this stands

Real managed infrastructure now exists. A Supabase project provides PostgreSQL 17 and a private
S3-compatible bucket, the application runs against both, and the restricted runtime role and
FORCE RLS are live there rather than only on a laptop.

That moves two gates and creates one that did not exist before: the staging credentials were
exposed during manual setup, and rotating them is now a precondition rather than hygiene.

| Gate                                | Status                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| Real managed PostgreSQL             | **VERIFIED**                                                                    |
| Restricted runtime role · FORCE RLS | **VERIFIED**                                                                    |
| S3-compatible evidence storage      | **VERIFIED** against a real S3 server; the same suite is the staging evidence   |
| Application evidence lifecycle      | **VERIFIED** end to end against a real object store                             |
| Persistent cloud container host     | **BLOCKED** — no host, no account                                               |
| Restore into a separate environment | **BLOCKED** — needs a second environment                                        |
| Human-visible alert destination     | **BLOCKED** — Telegram adapter built and tested; no bot delivered a message yet |
| Reproducible app-role provisioning  | **VERIFIED** — it did not exist before; see gate 4b                             |
| Credential rotation                 | **REQUIRED BEFORE REAL DATA**                                                   |
| Sentry ingestion                    | **BLOCKED** — adapter implemented, no DSN                                       |

### Who verified what, and how to reproduce it

An important distinction, because the two are not the same evidence.

**Verified by the operator, against the real Supabase project:** that the 18 migrations are
applied, that `distributor_app` has the six role attributes it must have, that FORCE RLS is
working, that the application starts, that liveness and readiness are green, and that the
Supabase S3 file store reports healthy.

**Verified here, reproducibly:** everything the commands below assert, against real PostgreSQL 17
and a real S3-compatible object store.

Those operator checks are not taken on trust — they are now _executable_, and the same commands
produce the same evidence against Supabase from any machine holding the credentials:

```bash
pnpm ops:verify-deployment --base-url https://<host> --expect-env staging   # role, RLS, grants, migrations
TEST_S3_ENDPOINT=… pnpm test:storage                                        # every storage capability
PLAYWRIGHT_BASE_URL=https://<host> pnpm test:smoke:staging                  # the transactional path
```

Until those have been run against the staging host and their output recorded, the rows above are
**reported** rather than **reproduced**, and this document says so rather than blurring them.

---

## Gate 1 — A real, persistent deployment

### **BLOCKED** — and the reason is now narrower than it was

**The infrastructure half is done.** Managed PostgreSQL 17 and a private S3-compatible bucket
exist, are provisioned, and the application runs against both. What is missing is a _host_: a
place where the container runs continuously, at a domain, with TLS, that survives a laptop being
closed.

**The artifact half is done.** The image builds and runs. The image — multi-stage, non-root,
tini-init, healthchecked, `BUILD_SHA` baked in — was run against real PostgreSQL 17 and a real
S3-compatible bucket with a production build, and everything §9 of the brief asks to confirm was
confirmed against the _running container_:

```
  ok    serving the expected commit — 22a5f62fe6b9d6fb88628b56a82dd94c09e30b23
  ok    build identifies itself — built 2026-08-23T13:31:44Z
  ok    environment is staging — reports staging
  ok    readiness answers 200
  ok    dependency database — ok in 7ms
  ok    dependency migrations — ok in 7ms
  ok    dependency file-store — ok in 14ms
  ok    runtime role is distributor_app
  ok    runtime role is not a superuser
  ok    runtime role does not bypass RLS
  note  2 table(s) exempt by design: memberships, sessions
  ok    row-level security enabled on all 26 tenant tables
  ok    row-level security forced
  ok    append-only tables cannot be updated or deleted by the app role
  ok    migrations are current — 0 unfinished
```

The full end-to-end suite then ran against that container: **193 passed, 7 skipped, 0 failed**,
desktop and mobile. And the evidence path was exercised from inside it, using the container's own
configuration and the least-privilege key — put, head with hash metadata, read back byte-identical,
delete.

### What building and running it found

Five defects, none of which could have been found by reading, because **Phase 9 shipped a
Dockerfile nobody had built and a container nobody had started.**

|     | Defect                                                              | Consequence                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `COPY /app/public` — this project has no such directory             | Build failed on that line                                                                                                                                                                                                                                                                              |
| 2   | Hand-copied `node_modules/.prisma`, `@prisma`, `prisma`             | Those paths exist under npm's flat layout and **not** under pnpm's symlinked store. Build failed. Next's tracing already handles the Prisma client — the copies were wrong _and_ unnecessary, and the running container proves it: the musl query engine is in the image and the database check passes |
| 3   | `pnpm install` pulled ~400 MB of Playwright browsers into the build | Twenty minutes per build for browsers a server image never uses                                                                                                                                                                                                                                        |
| 4   | **Configuration was never validated at startup**                    | See below — the serious one                                                                                                                                                                                                                                                                            |
| 5   | **The error reporter read configuration**                           | So it threw while reporting a configuration failure                                                                                                                                                                                                                                                    |

### Defect 4, in full

The runbook has always promised that the application _"refuses to start on a bad configuration
rather than running degraded"_. **It did not.** Configuration is read lazily, so a container
started with `APP_ENV=production` and `FILE_STORAGE_DRIVER=local` — the exact combination the
guards exist to refuse, because evidence on a container filesystem vanishes on restart — came up
like this:

```
 ✓ Starting...
 ✓ Ready in 267ms
=== live ===   200 {"status":"alive"}
=== ready ===  500
```

**Healthy, by the only signal a platform gates a rollout on.** Liveness answers 200, so traffic
moves to the new container and the old one is retired; nothing in that sequence consults
readiness. The deployment "succeeds", the distributor's staff hit errors, and the first clue is a
support call.

Readiness answering a bare `500` with an empty body is defect 5: `checkReadiness` threw on
`config()`, the route's catch called `captureException` to turn that into a diagnosable 503, and
`captureException` threw on `config()` too. The one code path whose job is to explain a failure
could not run during the failure it existed to explain.

Both are fixed: a startup check (`src/instrumentation.ts`) that reports **every** problem at once
and exits before serving anything, and an error reporter that falls back to logging when
configuration cannot be read. A container that dies at startup is a failed release on every
platform in the runbook; a container that comes up healthy and broken is not.

**Why it is still BLOCKED.** There is no container host. The database and the bucket are real;
the application still runs where somebody starts it, which is not a deployment. No hosting
account exists in this environment — no platform CLI is installed, no credential file exists,
and no relevant variable is set. Verified rather than assumed.

**"The artifact runs correctly against real infrastructure" and "the artifact is deployed" are
different claims.** The first is now earned twice over. The second is not, and reporting it
would be a fabrication.

### The exact missing dependency

An account with **one** of:

- a container host — Fly.io, Railway, Render, DigitalOcean App Platform, or any VM with Docker
- a managed PostgreSQL 17 instance
- an S3-compatible bucket — AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2
- a DNS name and TLS certificate

### The one remaining command

With credentials in place, [`deployment-runbook.md`](deployment-runbook.md) is executable as
written. Steps 1–3 and 8 need no cloud account; steps 4–7 are:

```bash
# 4. Build and push
docker build --build-arg BUILD_SHA=$(git rev-parse HEAD) \
             --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
             -t <registry>/distributor-os:$(git rev-parse --short HEAD) .
docker push <registry>/distributor-os:$(git rev-parse --short HEAD)

# 5. Migrate, as a separate step before traffic
DATABASE_URL="$PROD_DIRECT_URL" DIRECT_URL="$PROD_DIRECT_URL" pnpm prisma migrate deploy

# 6. Start the container with the production environment
#    (docs/secrets-and-environment.md lists every required variable)

# 7. Verify
curl -fsS https://<host>/api/health/ready
curl -fsS https://<host>/api/version     # commit must equal step 4's SHA
```

---

## Gate 2 — S3-compatible evidence storage

### **VERIFIED**

`S3FileStore` implements the `FileStore` interface Phase 5 designed. Selected by
`FILE_STORAGE_DRIVER=s3`; no module outside `src/platform/storage` names a backend, so the
payment workflow is unchanged.

**Tested against a real S3-compatible server (MinIO), not a mocked SDK.** 29 contract tests,
the same suite run against both the local store and S3, plus S3-specific failure tests.

That decision paid for itself immediately. Three real defects came out of asking a real server:

| Defect                                                          | Consequence had it shipped                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ServerSideEncryption: AES256` sent unconditionally             | **Every evidence upload would have failed** on any provider not configured for SSE. MinIO refuses it outright with "KMS is not configured" |
| An empty key returned a _successful_ response with a body       | `read('')` handed back bytes — one refactor from an information disclosure                                                                 |
| A traversal-shaped key threw where the local store returns null | Two implementations of one interface diverging on bad input                                                                                |

**Structural guarantees, each asserted by test:**

- **No URL method anywhere.** A test walks the class and fails if any method name contains "url",
  "presign" or "signed". A presigned URL is a bearer token for a bank slip: once issued it works
  for anybody holding it, for as long as it lives, and it cannot be revoked. Reads are proxied
  through the application route that checks session, permission and tenant first.
- **Opaque keys** — `organizations/<org-uuid>/payments/<uuid>`, never derived from a filename.
- **Possession of a key grants nothing.** Authorization is a database ownership check.
- **Content hash stored twice** — in the database and as object metadata — so a restore drill can
  verify the two against each other without trusting either to describe the other.
- **Health results leak nothing** — a category, never a bucket name, endpoint or credential.

Readiness now refuses to report READY when a production deployment configured for S3 cannot reach
it. A degraded store is still tolerated elsewhere, because quotations, orders, warehouse and
delivery all keep working — but a production deployment that selected S3 has declared evidence
storage required, and payments are half the product.

Also verified: **the same suite passes against the local store**, so the two are genuinely
interchangeable rather than merely both present.

### The application path, not just the adapter

The adapter was proven in isolation. The _application_ on top of it was not: every test that
touches evidence ran against an in-memory Map, so the sequence a distributor actually depends on
— a bank slip leaving a browser, landing in a bucket, coming back byte-identical through an
authenticated route — had never been exercised against a store that can fail.

It has now, and it is the suite that becomes the staging evidence:

```bash
TEST_S3_ENDPOINT="https://<project>.supabase.co/storage/v1/s3" TEST_S3_REGION=… TEST_S3_BUCKET=… TEST_S3_ACCESS_KEY_ID=… TEST_S3_SECRET_ACCESS_KEY=… pnpm test:storage
```

42 assertions covering upload validation, `put`, the database row that records the key and hash,
byte-identical retrieval of PDF **and** binary PNG/JPEG — what a phone actually uploads, and the
case a text-only test would never catch — and four ways a read fails closed: a foreign tenant's
id, a malformed id, an id never issued, and a key the store never made. All four answer
identically, so the response cannot be used to confirm that a file exists.

Pointed at Supabase, that one command answers every provider-compatibility question — path-style
addressing, HEAD metadata, missing-key behaviour, delete, health, timeouts — empirically rather
than by assumption. See [`supabase-staging.md`](supabase-staging.md) §3.

### The trust boundary, stated plainly

**Supabase's server-side S3 credentials bypass Storage RLS.** A key with `GetObject` on the
bucket reads every object in it, for every tenant, whatever the dashboard says. That is not a
flaw to work around; it is what a server-side key is.

So the provider's access control is **not** the boundary — the application is, and it rests on
three things now asserted by test rather than assumed:

1. **Credentials never reach the browser.** No `NEXT_PUBLIC_*` name may hold a secret; Next
   inlines those into the client bundle at build time with no runtime guard.
2. **The bucket is private.** An anonymous request for an object path is refused, and so is an
   anonymous listing. Checked against the real bucket, because a private bucket is a
   configuration and configurations drift.
3. **Every read passes session, permission and tenant checks first** — and a salesperson, who can
   attach a slip, can never read one back.

---

## Gate 3 — Restore into a separate environment

### **BLOCKED**

**What is done.** The drill has been run again, this time against the database the deployed
container is actually serving from, after the end-to-end suite had written a day's worth of work
into it. It compared 23 facts spanning every phase and every one matched:

```
  quotations            4690    salesOrders          1275
  payments               845    confirmedPayments     784
  confirmedPaymentTotalMinor   3,526,608,600  (ETB 35,266,086.00)
  stockReservations      475    inventoryMovements     275
  warehouseTasks         179    deliveries             115
  discrepancies           39    returns                  6
  auditEvents          16159    totalAvailableStock  67831
  sampleOrderNumber  SO-2026-05011  ·  PARTIALLY_PAID  ·  40411000

  Evidence files referenced by the restored database: 512
    present and hash-verified   512
    missing from the store      0
    present but hash mismatch   0

  RESTORE VERIFIED — every fact matched.
```

It verifies the dump against its recorded checksum first, so a corrupt backup fails the drill
rather than the emergency, and it restores into a scratch database it drops afterwards, so the
live one is never written to.

**One precision about the evidence half.** Those 512 files were verified in the _local_ store,
because that is where this database's historical evidence was written across Phases 5–8. The
check itself is store-agnostic — it goes through the same `FileStore` interface — and the
property it depends on is now asserted against S3 directly: a test replaces an object's bytes
behind the store's back, exactly as a corrupted transfer would, and confirms the hash no longer
agrees. An evidence store that quietly returns the wrong bank slip is worse than one that is
empty, because nothing announces it.

### Backing up Supabase, and the defect that found

`ops:backup` works against a managed database, after two fixes that only surfaced by asking it
to.

**It could have backed up the wrong database, silently.** The script always discarded the host in
the connection string and dumped whatever the local container held — correct in development,
where the URL names a port Docker publishes on the host. Point `DIRECT_URL` at Supabase, pass
`--container` because the machine has no `pg_dump`, and it would usually fail on an unknown
role — but where the local container happened to have a role and database of the same names,
which a stock `postgres` image gives you, it _succeeded_ and wrote the wrong database out under
a filename and checksum implying it was the staging backup. A backup of the wrong database is
worse than no backup: it restores cleanly, and the mistake surfaces only when somebody looks for
a row that was never in it. The host now decides, and a remote host is passed through:

```
  Using "distributor-os-postgres" as a pg_dump client for aws-0-eu-west-1.pooler.supabase.…
  pg_dump: error: could not translate host name … to address: Name does not resolve
```

Loud, and about the right database.

**And the dump would not have restored.** On a managed provider the database is shared with the
provider's own machinery — `auth`, `storage`, `realtime`, `graphql`, owned by roles that
exist nowhere else. An unscoped dump drags all of it along and then fails to restore into a plain
PostgreSQL 17, which is exactly what the drill restores into. Dumps are now scoped to
`--schema=public`, which is where all of this application's data lives; re-verified by a full
drill, 23 facts and 512 evidence files.

**Why it is still BLOCKED.** The gate requires restoring into a **separate** environment, and
there is only one. A drill that restores into a scratch database beside the original proves the
dump is complete; it does not prove the recovery path works when the environment itself is what
was lost. That needs a second Supabase project, branch, or host — which is not provisioned, and
simulating it locally would be answering a different question.

### Evidence files are a separate recovery problem

**A database backup is not evidence recovery**, and calling the primary bucket healthy is not
either. The database holds the storage key and the content hash; the bytes are in the bucket.
Restore the database alone and every payment row points at a file that may not exist — and the
slip is the thing a payment dispute turns on.

The proportionate pilot arrangement is a scheduled `rclone sync --immutable` to a second private
bucket in a different account, plus versioning on the primary. `--immutable` because evidence is
write-once: a modified object is a signal, not something to mirror faithfully. Detail in
[`supabase-staging.md`](supabase-staging.md) §5.

That mirror is a **plan, not a verified recovery**, and is recorded as such until a drill has
restored from it.

---

## Gate 4 — A human-visible alert destination

### **VERIFIED (mechanism)** · **BLOCKED (destination)**

Recorded as two halves because they clear differently, and conflating them would overstate one.

**The mechanism is proven.** Every exit path from `ops:backup` that means "no backup was taken"
delivers an alert, and it was tested by causing a real failure:

```
=== deliberate backup failure: nonexistent container ===
pg_dump failed:
Error response from daemon: No such container: no-such-container-exists

  alert delivered: file
  alert delivered: webhook (127.0.0.1:9099)

=== receiver ===
RECEIVED: {"text":"🔴 *CRITICAL* — Database backup FAILED\nEnvironment: staging\n…
```

A real HTTP POST to a real receiver, with a Slack-compatible payload, HTTP 200. The alert is
awaited before the process exits — exiting with a fetch in flight cancels it, which would mean
the one alert that mattered was the one that never arrived. The destination is reported as a host
only, because a webhook URL embeds a secret token in its path.

`ops:check-backup-freshness` covers what a failure alert structurally **cannot**: a schedule that
stopped running. That produces no error, no log line and no alert — just an ageing directory
nobody looks at. It also verifies the newest dump against its checksum, because a dump truncated
by a full disk has a recent timestamp and a plausible size.

Both paths tested:

```
  Newest backup   distributor_os-phase9-drill-…dump
  Age             1.8h (limit 48h)   Checksum  verified
  Backups are current.

  Backups are stale
  The newest backup is 1.8h old (limit 0h). The schedule may have stopped running.
  alert delivered: file
```

### Telegram, and why it needed its own adapter

Telegram is the intended destination: the owner and whoever carries the phone are already on it,
it needs no workspace administration, and a phone notification at 2 a.m. is the whole point.

It does **not** fit the generic webhook, and the reason is worth recording rather than working
around. `sendMessage` requires a `chat_id` the generic sink has nowhere to put, and the bot
token is a **path segment** of the URL — so reusing `ALERT_WEBHOOK_URL` would mean keeping a bot
token in a variable that gets pasted into runbooks. So `AlertSink` now has three
implementations: file, webhook, Telegram.

Ten tests against a real local HTTP server, not a mock, including the two that matter:

- **the bot token never appears** in anything printed — not in `destination`, not in `note`,
  not on the failure paths, which are the ones that usually leak because an exception carries the
  URL that produced it. The sink identifies itself as `telegram (chat …7890)`
- **an `ok: false` body is a failure** whatever the HTTP status says, because reporting a
  failed delivery as delivered is the one lie this script must never tell

Messages are plain text with no `parse_mode`: MarkdownV2 requires escaping fourteen characters,
an unescaped one is a 400 rather than a formatting glitch, and alert details are full of file
paths, exit codes and `pg_dump` output. An alert that fails to send because a hyphen appeared in
an error message is worse than an alert without bold text.

### Three more alerts that had no mechanism at all

`ops:check-readiness` polls `/api/health/ready` on a schedule and covers readiness failure,
database unavailable and evidence storage unavailable — all named in the alert plan, none of them
previously watched by anything. Proved against a real container with an unreachable bucket:

```
  CRITICAL — Application NOT READY
  HTTP 503 from 127.0.0.1:3202
  Failing: file-store: degraded

  alert delivered: file
  alert delivered: webhook (127.0.0.1:9099)
```

It distinguishes two states that look alike: a 503 means the application answered and told the
truth about itself; unreachable means nobody answered at all, which is where silence is most
likely to be mistaken for health.

**Repeated severe server failures are deliberately not covered here.** That needs log
aggregation the pilot does not have; `ERROR_REPORTING_DSN` pointed at Sentry is the answer, and
its alerting rules belong there. Saying so beats listing it as though a cron job were watching.

**Why the destination half is BLOCKED.** No bot token and no chat id exist in this environment, so
nothing has arrived on anybody's phone. The delivery path is proven against a real server; the
human at the other end does not exist yet.

### What clears it

```bash
# with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID set
pnpm ops:notify --test     # exits non-zero unless a *person* was reached
```

That exit code is itself a fix. It used to be satisfied by the local file write, which always
succeeds — so the test passed on a machine with no destination configured at all, which is
precisely the state it exists to detect. A test that cannot fail is not a test.

Then schedule all three, **from a machine that is not the application host**:

```
0 2 * * *    pnpm ops:backup --label nightly
0 8 * * *    pnpm ops:check-backup-freshness --max-age-hours 48
*/5 * * * *  pnpm ops:check-readiness --base-url https://<host> --quiet-when-healthy
```

A checker sharing a machine with the thing it checks dies with it, and that is exactly the
failure it exists to catch.

---

## Gate 4b — Provisioning the application role

### **VERIFIED (mechanism)** — and it was missing entirely

The role that makes tenancy real, `distributor_app`, was **not provisioned by anything in this
repository**. Its `CONNECT`, schema `USAGE`, table and sequence grants — and the
`ALTER DEFAULT PRIVILEGES` that covers tables created by _future_ migrations — lived only in
`docker/init-test-db.sql`, which Postgres runs once when a Docker volume is first initialised.

Managed PostgreSQL has no `docker-entrypoint-initdb.d`. So setting up the Supabase staging
project meant typing those grants by hand, correctly, from memory — and the most forgettable one
is the one whose absence is invisible: without the default privileges, a table added by some
later migration is unreadable by the application while everything else keeps working.

It surfaced locally in the ugliest possible way. `pnpm db:reset` drops and recreates schema
`public`, which takes the grants with it; the migrations replayed, every table came back, and
the application answered `permission denied for schema public` on every page. It presented as
twenty-nine unrelated end-to-end failures.

`pnpm ops:provision-role` now does it idempotently against any database, asserts
`NOSUPERUSER NOBYPASSRLS` every run rather than only at creation, and prints what it ended up
with. `pnpm db:reset` re-runs it, so that command can no longer leave a database the
application cannot use.

**This is a prerequisite for any new environment**, including the second one gate 3 needs.

---

## Gate 5 — Credential rotation

### **REQUIRED BEFORE REAL DATA**

The Supabase staging credentials were exposed during manual setup. That is ordinary — a
connection string gets pasted into a terminal that logs to scrollback, a key is read aloud, a
screenshot is taken. What would not be ordinary is carrying them into an environment holding a
distributor's payment records, because the pilot is the moment a leaked credential stops being
worth nothing and starts being worth somebody's commercial history.

Rotate in order, because each step invalidates what the previous one used: **database admin
password → `distributor_app` password → S3 access key pair (revoke the old one; an
unused-but-valid key is a key) → `SESSION_SECRET` if it was ever displayed → the runtime secret
store → restart.**

Then prove it landed, rather than assuming:

```bash
pnpm ops:verify-deployment --base-url https://<staging-host> --expect-env staging
pnpm test:storage     # TEST_S3_* pointed at the new key pair
```

Readiness green _after_ a rotation is the only evidence the new credentials work. Readiness green
before one proves nothing about it. Procedure in
[`secrets-and-environment.md`](secrets-and-environment.md) §4.

**No credential value appears in this repository, and none should be added to it.**

---

## Gate 6 — Error reporting

### **BLOCKED (ingestion)** — adapter implemented and ready

`ERROR_REPORTING_DSN` was a seam that logged "forward_pending" and sent nothing. It now sends to
Sentry over the envelope endpoint, with no vendor SDK — deliberately: `@sentry/node`
auto-instruments http and the Postgres driver and captures request payloads by default, which is
the wrong shape for an application whose payment design rests on evidence never leaving the
building. One POST of a JSON body means **everything that leaves the process is visible in one
file**.

What is sent: exception type, scrubbed message, correlation id, route, environment, release
(`BUILD_SHA`, so "this started with that deploy" is answerable), organization and user ids —
opaque uuids that carry no personal data and without which a report cannot be traced to the
tenant that hit it.

What cannot be sent, by construction: `scrub()` removes credentials in URLs, long opaque runs
(tokens, keys, hashes) and any run of eight or more digits — a bank account or transaction
reference. Order numbers like `SO-2026-05011` survive, because the hyphens break the run. The
free-form `context` bag is **not forwarded at all**: its contents are decided at hundreds of
call sites, and the one guarantee this integration must make is that nothing unreviewed leaves.

Nothing here can break a request: the local structured log is written first and always, the send
is fire-and-forget behind a five-second timeout, and every failure is swallowed after being
logged. An error reporter that can throw turns one failure into two, and the second has no
reporter left to describe it.

**BLOCKED on ingestion only**: no DSN exists in this environment, so no event has been accepted by
Sentry. Set `ERROR_REPORTING_DSN` and confirm an event arrives. A DSN that is not a Sentry DSN
logs a warning once and falls back to logging, rather than silently discarding reports.

---

## Supporting gates

|                                                | Status    | Evidence                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Staging E2E green                              | **READY** | 193 pass, 7 skipped, 0 failed, desktop and mobile — and separately against the containerised production build                                                                                                                                                                                                      |
| Full test suite                                | **READY** | 1,514 passed, 2 skipped, 48 files — integration against real PostgreSQL 17 and a real S3-compatible store                                                                                                                                                                                                          |
| Migration replay on a fresh database           | **READY** | All 18 replay; RLS enabled _and_ forced, role attributes, append-only grants, 3 immutability triggers, 26 policies                                                                                                                                                                                                 |
| Deployment failure rehearsal                   | **READY** | 10 refused configurations, each exiting 1 and serving nothing, each naming the setting and not its value                                                                                                                                                                                                           |
| Transactional smoke, pointable at a deployment | **READY** | `PLAYWRIGHT_BASE_URL=… pnpm test:smoke:staging` runs the suite against a running host without starting a local server. **It writes** — customers, stock, payments — and refuses `APP_ENV=production` before collecting a test. `ops:verify-deployment` is the read-only one; they are separate commands on purpose |
| Storage suite, pointable at any provider       | **READY** | `pnpm test:storage` — 42 assertions; `TEST_S3_*` aims it at Supabase                                                                                                                                                                                                                                               |
| DB role / RLS verified                         | **READY** | Against the running container's own connection: `distributor_app`, not superuser, no BYPASSRLS, RLS enabled _and_ forced on all 26 tenant tables, append-only grants revoked, 0 unfinished migrations                                                                                                              |
| No P0 security findings                        | **READY** | [`phase-9-security-review.md`](phase-9-security-review.md); 11 dependency advisories, all build/test tooling, none reachable from the container                                                                                                                                                                    |
| Secrets clean                                  | **READY** | `ops:scan-secrets`: nothing found. The runtime image carries no `.env` and no secret-shaped variable — only `BUILD_SHA` and `BUILD_TIME`                                                                                                                                                                           |
| Readiness behaves under failure                | **READY** | Production build with an unreachable bucket: liveness 200, readiness **503**, `file-store: degraded (unauthorized)`. Alive but not taking traffic, which is the correct pair                                                                                                                                       |
| Kill switch                                    | **READY** | Writes refused, reads intact, lifted cleanly — and lifting does **not** restore UPDATE/DELETE on the append-only tables, which a naive restore would have                                                                                                                                                          |

---

## Verdict

### **NOT READY FOR REAL DATA**

Real managed infrastructure now exists and is proven. What remains is a **host**, a **second
environment**, a **phone**, and a **rotation**.

| Gate                                    | Status                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1 · Persistent cloud container host     | **BLOCKED** — database and bucket are real; the application still runs where somebody starts it |
| 2 · S3-compatible evidence storage      | **VERIFIED** — adapter _and_ application path, against a real object store                      |
| 3 · Restore into a separate environment | **BLOCKED** — one environment cannot be a restore target for itself                             |
| 4 · Human-visible alert destination     | **VERIFIED** (mechanism) · **BLOCKED** (nothing has reached a phone)                            |
| 4b · Reproducible app-role provisioning | **VERIFIED** — it did not exist at all before                                                   |
| 5 · Credential rotation                 | **REQUIRED BEFORE REAL DATA**                                                                   |
| 6 · Error reporting ingestion           | **BLOCKED** — adapter ready, no DSN                                                             |

Three of these are one purchase away: a container host clears 1, gives 3 somewhere to restore
_from_, and a Telegram bot takes ten minutes. Gate 5 costs nothing but must not be skipped.

### Why the verdict stays conservative

The database is real and the bucket is real, which makes it tempting to treat the rest as
paperwork. It is not, for one reason that this task demonstrated again: **every defect found here
was found by doing something that had previously only been written down.**

Backing up against a managed database would have dumped the _wrong_ database under a filename
implying it was the staging backup — and then produced a dump that could not restore into plain
PostgreSQL anyway. The alerting self-test passed on a machine where no alert could reach anybody.
The error reporter sent nothing at all. Nothing provisioned the database role the whole tenancy
story depends on. And the receivables page — the list a distributor uses to decide who to chase —
had been under-reporting what customers owed for every organization past 500 orders, disagreeing
with the dashboard that links to it.

None of that was visible by reading. All of it was visible within minutes of running the thing.

The gates that remain are the ones nobody has run yet. That is precisely why a distributor's real
data should not be present for the first attempt.

**Do not import real distributor data.** When the six are green, the sequence is
[`pilot-onboarding.md`](pilot-onboarding.md), then a **one-week parallel run** measured by
[`pilot-measurement-plan.md`](pilot-measurement-plan.md) — where the question is not whether
people liked the interface, but whether both systems agreed on consequential business numbers.
