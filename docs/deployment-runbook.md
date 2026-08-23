# Production Deployment Runbook

Written to be executed by somebody who did not build this. Every step is a command or a check
with a stated pass condition; nothing relies on knowing what the author meant.

If a step fails, **stop**. §8 is what to do then.

---

## 0. The target

| Piece | Choice |
|---|---|
| Application | one container, `Dockerfile` at the repository root |
| Database | managed PostgreSQL 17 |
| Evidence | S3-compatible bucket, private, versioned |
| TLS | terminated at the platform; `APP_URL` must be `https://` |
| Monitoring | external uptime check on `/api/health/ready` |

Serverless was rejected deliberately: every concurrency guarantee in Phases 4–7 rests on real
transactions holding real row locks, and a connection model that recycles between statements
fights that design. Kubernetes was rejected as a Phase 9 non-goal, and correctly — one pilot does
not need an orchestrator.

Two database roles, and this is not optional:

- **`distributor`** — owner. Used *only* by `prisma migrate deploy`.
- **`distributor_app`** — `NOSUPERUSER`, `NOBYPASSRLS`. What the application connects as.

RLS policies do not apply to a superuser. If the application connects as the owner, every tenancy
guarantee in this codebase silently evaporates while every test still passes.

---

## 1. Before you start

```bash
git status --short          # must be empty
git log --oneline -1        # note the SHA; you will verify it in §7
```

- [ ] CI is green on this exact commit
- [ ] you can reach the production database
- [ ] you know how to roll back the container image
- [ ] somebody else knows you are deploying

---

## 2. Back up

**Not optional, and not "the platform does it".** A migration is the most likely thing in this
runbook to need a restore.

```bash
pnpm ops:backup --label "pre-deploy-$(git rev-parse --short HEAD)"
sha256sum -c backups/*pre-deploy*.sha256
```

- [ ] the dump exists and its checksum verifies
- [ ] the object store's newest version is recent

---

## 3. Inspect what will run

```bash
DATABASE_URL="$PROD_DIRECT_URL" pnpm prisma migrate status
```

Read the pending migrations. For each one, decide:

- **additive** (new table, new nullable column, new index) — safe; old code keeps working
- **destructive** (drop, rename, NOT NULL on existing data, type change) — **stop**, and read
  [`docs/migration-runbook.md`](migration-runbook.md) §3 before continuing

- [ ] every pending migration is additive, or the destructive ones have a plan

---

## 3b. Provision the evidence bucket

Once, before the first deploy. The bucket holds photographs of customers' bank slips, so its
settings are not defaults to accept but decisions to make.

| Setting | Value | Why |
|---|---|---|
| Public access | **blocked** | Evidence is served only through the authenticated read route |
| ACLs | disabled / bucket-owner-enforced | The adapter sends no ACL at all; the bucket policy is the single place visibility is decided |
| Versioning | **on** | An overwrite or an accidental delete is recoverable. Evidence is the thing a payment dispute turns on |
| Default encryption | on (SSE-S3 or provider equivalent) | Configured on the bucket, not sent per-request — see below |
| Lifecycle | none for now | Retention is a policy decision; see [`data-retention-and-privacy.md`](data-retention-and-privacy.md) |

**Do not set `S3_SERVER_SIDE_ENCRYPTION` unless the provider demands the header.** The adapter
sends no encryption header by default, and that default was earned: an earlier version sent
`AES256` unconditionally, assuming a provider without support would ignore it. MinIO refuses the
upload outright — "KMS is not configured" — which would have failed *every* evidence upload.
Bucket-level default encryption achieves the same result, applies to anything else that writes to
the bucket, and does not depend on every client remembering a header.

Create a key scoped to this bucket alone. Four actions are needed and no more:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::<bucket>"] },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::<bucket>/*"] }
  ]
}
```

`s3:ListBucket` is what the readiness probe's `HeadBucket` needs; without it a healthy bucket
reports itself unauthorized. This exact policy has been exercised against a real S3-compatible
server: put, head, read, delete and health all succeed with it, and the same key against a
neighbouring bucket reports `unauthorized` rather than reading anything.

- [ ] public access blocked, and verified by fetching an object URL directly — it must refuse
- [ ] versioning on
- [ ] the application's key can reach this bucket and no other

---

## 4. Build

```bash
docker build \
  --build-arg BUILD_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t distributor-os:$(git rev-parse --short HEAD) .
```

`BUILD_SHA` is what `/api/version` reports. A build without it is refused at startup in
production, because "which version are you running" is the first question on every support call.

---

## 5. Migrate

Migrations run **before** the new container serves traffic, as a separate step. Never as part of
container startup: with more than one instance they would race, and a failure at startup is
indistinguishable from a crash loop.

```bash
DATABASE_URL="$PROD_DIRECT_URL" DIRECT_URL="$PROD_DIRECT_URL" \
  pnpm prisma migrate deploy
```

- [ ] exit code 0
- [ ] `prisma migrate status` reports nothing pending

**If this fails, stop and go to §8.** Do not start the new container against a half-migrated
database.

---

## 6. Deploy

Start the new container with the production environment (see
[`docs/secrets-and-environment.md`](secrets-and-environment.md)). Required, and each one is
enforced at startup:

```
APP_ENV=production
APP_URL=https://<host>          # https, or startup fails
DATABASE_URL=...                # distributor_app
SESSION_SECRET=...              # 32+ chars, generated
AI_PROVIDER=anthropic|disabled  # "mock" is refused
FILE_STORAGE_DRIVER=s3          # "local" is refused
S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
BUILD_SHA, BUILD_TIME
```

The application refuses to start on a bad configuration rather than running degraded, and prints
every problem at once:

```
Refusing to start: the environment is not a valid configuration.

  - FILE_STORAGE_DRIVER: FILE_STORAGE_DRIVER="local" is refused in production: container
    filesystems are ephemeral and payment evidence would be lost on restart.

Nothing was served. See docs/secrets-and-environment.md for what each setting requires.
```

Settings are named; values never are, because this text lands in a deployment log.

**This sentence used to be aspirational.** Configuration was read lazily, so a container with a
refused configuration started normally, logged `✓ Ready`, and passed its liveness healthcheck —
which is the only signal a platform gates a rollout on. The rollout would complete, the old
container would be retired, and staff would meet errors on real work. It was found by rehearsing
it rather than by reading, and it is now checked at startup, before the first request.

Ten refused configurations are rehearsed as part of the release exercise: local storage in
production, the mock AI provider in production, plain http, a placeholder or low-entropy session
secret, a missing build SHA, S3 selected with no bucket, the Anthropic provider with no key,
staging with no `APP_URL`, and no database URL. Each exits 1 and serves nothing.

---

## 7. Verify

One command asks every question this section used to ask by hand, and a few it did not:

```bash
DATABASE_URL="$PROD_APP_URL_TO_DB" \
  pnpm ops:verify-deployment \
    --base-url https://<host> \
    --expect-sha $(git rev-parse HEAD) \
    --expect-env production
```

It checks over HTTP that the deployment is live, is serving *this* commit, believes it is in the
environment you think, and reports every readiness dependency `ok`. Then, over the database
connection **the application itself uses**, it checks that the runtime role is `distributor_app`,
is not a superuser and does not bypass RLS; that row-level security is enabled *and forced* on
every tenant table; that the append-only tables cannot be updated or deleted by the app role; and
that no migration is unfinished.

`DATABASE_URL` must be the application's connection string, not the owner's. A verification run
as the owner would pass while the application ran as something else entirely — which is the exact
mistake that silently removes every tenancy guarantee in the system.

Anything it could not establish from where it ran is printed as `????` and counted separately. It
never reports an unchecked thing as a pass.

The raw endpoints, if you want them:

```bash
curl -fsS https://<host>/api/health/live      # {"status":"alive"}
curl -fsS https://<host>/api/health/ready     # {"status":"ready", checks:[...]}
curl -fsS https://<host>/api/version          # commit must equal §1's SHA
```

- [ ] `ops:verify-deployment` exits 0
- [ ] readiness is 200 and every check is `ok`
- [ ] the reported commit is the one you built

In production with `FILE_STORAGE_DRIVER=s3` a degraded `file-store` is **not** acceptable and
readiness will already be reporting 503: that configuration declares evidence storage to be a
required dependency, and payments cannot be submitted or reviewed without it.

Then the first sign-in, **by hand, in a browser**.

An earlier version of this runbook said to run `pnpm test:smoke --base-url <host>` and called it
read-only and production-safe. It was neither: no such script exists, and the end-to-end suite it
pointed at signs in as seeded demo users, creates customers and adjusts stock. Running it against
a production deployment would have written test data into a distributor's system — and it would
have failed at the first step anyway, because a production database has no `@addisbuild.example`
users in it.

The honest post-deploy check is the one the operator is about to perform regardless:

```bash
pnpm admin:create-organization      # prints the owner's password once
```

Then, signed in as that owner:

- [ ] login works, and the session persists across a page load
- [ ] the dashboard renders (it will be empty — nothing has been imported yet)
- [ ] customers, products, orders and quotations pages load
- [ ] signing out returns to the login page, and the back button does not restore the session

The end-to-end suite belongs to CI and to a staging environment with synthetic data. It is not a
production smoke test and must never be pointed at one.

---

## 8. When something fails

**Code rollback and database rollback are different operations, and only one of them is easy.**

| Situation | Action |
|---|---|
| Migration failed, nothing applied | Fix forward. Nothing is deployed; no rollback needed |
| Migration partly applied | **Do not re-run.** Read [`docs/migration-runbook.md`](migration-runbook.md) §4 |
| Migration fine, application unhealthy | Roll the image back to the previous tag. Safe **only if** the migrations were additive — which is why §3 makes you check |
| Data is wrong | Restore per [`docs/backup-and-restore-runbook.md`](backup-and-restore-runbook.md) §6. Restore into a *new* database; the damaged one is evidence |

**Prisma does not roll migrations back.** There is no `migrate down`. A schema change is undone by
writing a new migration that reverses it, which is a forward fix wearing a rollback's clothes.
Saying otherwise in a runbook would be worse than saying nothing, because it would be read during
an incident.

This is why §3 insists on additive migrations: an additive change means the previous image still
works against the new schema, and a code rollback is genuinely available.

---

## 9. After

- [ ] watch error logs for 15 minutes (filter by the correlation ids in any reports)
- [ ] confirm the uptime check is green
- [ ] tell whoever needs to know that it is done, and what changed

---

## 10. What this runbook cannot promise

**No production deployment has been performed from this repository.** The first execution of §4
to §7 against a live host will be the first.

What has changed is how much of it is now rehearsed rather than merely written. §4 builds an
image that has been built; §6's environment has been started, and nine variations of it have been
refused; §7's verification is a script that has been run against a container serving real
PostgreSQL and a real S3-compatible bucket, with the full end-to-end suite passing against it.

That rehearsal found five defects in this runbook's own path, four of them fatal to the deploy and
one of them silent — the container that came up healthy on a configuration the guards were
supposed to refuse. **All five existed because Phase 9 wrote the deployment and never performed
it.** That is the argument for treating the first real deploy as an exercise with nobody depending
on it: expect it to surface something, because every previous first attempt did.
