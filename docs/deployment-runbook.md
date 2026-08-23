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

The application refuses to start on a bad configuration rather than running degraded. That is
deliberate: a failed deploy is visible, and a production deployment quietly using the mock AI
provider or ephemeral local storage is not.

---

## 7. Verify

```bash
curl -fsS https://<host>/api/health/live      # {"status":"alive"}
curl -fsS https://<host>/api/health/ready     # {"status":"ready", checks:[...]}
curl -fsS https://<host>/api/version          # commit must equal §1's SHA
```

- [ ] readiness is 200 and every check is `ok` (`file-store` may be `degraded`; nothing else may)
- [ ] the reported commit is the one you built

Then the smoke test — read-only, and safe against production:

```bash
pnpm test:smoke --base-url https://<host>
```

- [ ] login works
- [ ] dashboard loads with figures
- [ ] customers, products, orders and quotations list

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

**No production deployment has been performed from this repository.** Everything above has been
written against a real container image, a real migration set that replays onto an empty database,
and a restore that actually happened — but the first execution of §4 to §7 against a live host
will be the first. Expect it to surface something, and treat the first deploy as an exercise with
nobody depending on it.
