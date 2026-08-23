# Pilot Launch Gate

The four blockers from the Phase 9 readiness report, and whether each is cleared.

**One BLOCKED item means: do not import real distributor data.**

No percentage. Four independent gates, each READY or BLOCKED, with the evidence that decided it.

---

## Blocker 1 — Real deployment

### **BLOCKED**

**What is done.** The artifact exists, builds, and runs. The image — multi-stage, non-root,
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

**Why it is still BLOCKED.** No cloud deployment has been performed, because this environment has
no cloud credentials: no AWS, Fly, DigitalOcean, GCP, Azure, Render, Railway or Vercel CLI is
installed, no credential file exists, no cluster is reachable, and no relevant environment
variable is set. Verified rather than assumed.

**"The artifact runs correctly" and "the artifact is deployed" are different claims.** Only the
first has been earned, and reporting the second would be a fabrication.

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

## Blocker 2 — S3-compatible evidence storage

### **READY**

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

---

## Blocker 3 — Restore against the deployed environment

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

**One precision about the evidence half.** Those 512 files were verified in the *local* store,
because that is where this database's historical evidence was written across Phases 5–8. The
check itself is store-agnostic — it goes through the same `FileStore` interface — and the
property it depends on is now asserted against S3 directly: a test replaces an object's bytes
behind the store's back, exactly as a corrupted transfer would, and confirms the hash no longer
agrees. An evidence store that quietly returns the wrong bank slip is worse than one that is
empty, because nothing announces it.

**Why it is still BLOCKED.** A drill against the *deployed* environment requires a deployed
environment, and blocker 1 has not produced one. What has been drilled is the database a
containerised production build was serving — closer than the previous run, and still not the
claim. The mechanism is proven twice over; "restores correctly in production" is a different
sentence, and it stays unsaid until there is a production.

### What clears it

Once deployed, with only synthetic data present:

```bash
pnpm ops:backup --label pre-pilot
pnpm ops:restore-drill --dump ./backups/<file>.dump --container <container>
```

The drill already checks everything §13 of the brief asks for — organization, users, products,
inventory movements, quotations, approvals, orders, reservations, payments, audit history,
warehouse tasks, deliveries and returns — and it restores into an isolated scratch database that
it drops afterwards, so production is never touched.

---

## Blocker 4 — Backup failure alerting

### **READY (mechanism)** · **BLOCKED (destination)**

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

**Why the destination half is BLOCKED.** No Slack workspace, email service or platform alert
destination is connected to this environment, so `ALERT_WEBHOOK_URL` points at nothing real. The
delivery path is proven; the human at the other end does not exist yet.

### What clears it

Set `ALERT_WEBHOOK_URL` to a real Slack/Discord/Google Chat incoming webhook, then:

```bash
pnpm ops:notify --test           # confirm it arrives where a person will see it
```

and schedule both jobs:

```
0 2 * * *   cd /srv/distributor-os && pnpm ops:backup --label nightly
0 8 * * *   cd /srv/distributor-os && pnpm ops:check-backup-freshness --max-age-hours 48
```

The freshness check should run **from a different machine or scheduler** than the backup, because
a checker sharing a crontab with the thing it checks dies with it.

---

## Supporting gates

| | Status | Evidence |
|---|---|---|
| Staging E2E green | **READY** | 193 specs pass, desktop and mobile — **run against the containerised production build**, not a dev server |
| Full test suite | **READY** | 1,481 passed, 1 skipped, 44 files — integration against real PostgreSQL 17 and real MinIO |
| Deployment failure rehearsal | **READY** | 10 refused configurations, each exiting 1 and serving nothing, each naming the setting and not its value |
| Production synthetic smoke | **BLOCKED** | Needs blocker 1 |
| DB role / RLS verified | **READY** | Against the running container's own connection: `distributor_app`, not superuser, no BYPASSRLS, RLS enabled *and* forced on all 26 tenant tables, append-only grants revoked, 0 unfinished migrations |
| No P0 security findings | **READY** | [`phase-9-security-review.md`](phase-9-security-review.md); 11 dependency advisories, all build/test tooling, none reachable from the container |
| Secrets clean | **READY** | `ops:scan-secrets`: nothing found. The runtime image carries no `.env` and no secret-shaped variable — only `BUILD_SHA` and `BUILD_TIME` |
| Readiness behaves under failure | **READY** | Production build with an unreachable bucket: liveness 200, readiness **503**, `file-store: degraded (unauthorized)`. Alive but not taking traffic, which is the correct pair |
| Kill switch | **READY** | Writes refused, reads intact, lifted cleanly — and lifting does **not** restore UPDATE/DELETE on the append-only tables, which a naive restore would have |

---

## Verdict

### **NOT READY FOR REAL DATA**

Two of four blockers cleared, and both of the remaining two reduce to the same missing thing: a
hosting account.

| Blocker                      | Status                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| 1 · Real deployment          | **BLOCKED** — no cloud credentials in this environment         |
| 2 · S3 evidence storage      | **READY** — implemented and proven against a real S3 server    |
| 3 · Production restore drill | **BLOCKED** — requires blocker 1                               |
| 4 · Backup alerting          | **READY** (mechanism) · **BLOCKED** (no destination connected) |

**Everything that could be built and proven without an account has been.** What remains is not
engineering: it is provisioning a host, a database, a bucket, a domain and a Slack webhook, then
executing a runbook that is already written and now rehearsed as far as it can be locally.

That rehearsal is the part worth insisting on. Eight real defects were found by *doing* things
that had previously only been written down — five in the container path, three in the storage
adapter — and one of them, a production container that came up healthy on a configuration the
guards were supposed to refuse, would have produced a deployment that looked successful and was
not. **None of them were visible by reading.** That is the whole case for the remaining two
blockers: the first execution of anything is where its defects live, and a distributor's real
data should not be present for it.

**Do not import real distributor data.** Once the four are green, the sequence is
[`pilot-onboarding.md`](pilot-onboarding.md), then a **one-week parallel run** measured by
[`pilot-measurement-plan.md`](pilot-measurement-plan.md) — where the question is not whether
people liked the interface, but whether both systems agreed on consequential business numbers.
