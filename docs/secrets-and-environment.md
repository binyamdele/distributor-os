# Secrets and Environment

Every setting the application reads, what it does, and which environments require it.

**No value in this document is a real secret.** Nothing here, in the repository, in the seed, in
any test fixture or in any log line is a credential. `pnpm ops:scan-secrets` runs in CI to keep it
that way.

---

## 1. Four environments

`APP_ENV`, which is deliberately *not* `NODE_ENV`.

| `APP_ENV` | Build | Data | Demo seed | Destructive reset | Mock AI |
|---|---|---|---|---|---|
| `development` | dev | synthetic | yes | yes | yes |
| `test` | test | synthetic | yes | yes | yes |
| `staging` | production | synthetic | no | no | yes |
| `production` | production | **real** | **no** | **no** | **no** |

Staging runs a production *build* (`NODE_ENV=production`) against fabricated data. Keying these
decisions off `NODE_ENV` would force a choice between staging that cannot rehearse a release
properly and production that inherits staging's permissions. Neither is acceptable, so the
deployment target is named separately.

`APP_ENV` defaults to `development`. Production has to be asked for explicitly, so a deployment
that forgets the variable is refused by the production checks rather than quietly running with
development's guard rails.

---

## 2. Every setting

### Required everywhere

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Application connection. **Must be `distributor_app`**, which is `NOSUPERUSER`/`NOBYPASSRLS` — RLS does not apply to a superuser, so connecting as the owner silently voids every tenancy guarantee |
| `SESSION_SECRET` | Signs session cookies. 32+ characters. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |

### Required in staging and production

| Variable | Purpose |
|---|---|
| `APP_URL` | The origin this is served from. Must be `https://` in production |

### Required in production

| Variable | Purpose |
|---|---|
| `BUILD_SHA` | The deployed commit. Injected at image build. Startup refuses `unknown` |
| `FILE_STORAGE_DRIVER=s3` | `local` is refused: container filesystems are ephemeral and evidence written there vanishes on restart |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Evidence storage |
| `AI_PROVIDER` | `anthropic` or `disabled`. `mock` is refused |

### Migrations only

| Variable | Purpose |
|---|---|
| `DIRECT_URL` | The **owner** connection. Used by `prisma migrate deploy` and by `ops:backup`. The application never uses it. A backup taken as the app role would contain no rows at all, because RLS is `FORCE`d |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_POOL_SIZE` | `10` | Small on purpose: a container that opens more than its share of a capped managed plan starves the migration job and any admin session trying to diagnose it |
| `DATABASE_POOL_TIMEOUT_SECONDS` | `20` | Without it, a request that cannot get a connection waits forever and the user watches a spinner |
| `ANTHROPIC_API_KEY` | — | Required when `AI_PROVIDER=anthropic`; startup refuses the combination without it |
| `AI_TIMEOUT_MS` | `20000` | A provider that stops answering must not hold a request open |
| `ERROR_REPORTING_DSN` | — | Absent means log-only, which is a workable pilot position |
| `RATE_LIMIT_ENABLED` | `true` | Opt-*out*, so switching it off during an incident is a visible act |
| `LOG_LEVEL` | `info` (`debug` in development) | |
| `DEMO_MODE` | `false` | The one escape hatch, and it is narrow — see §5 |

---

## 3. Where secrets live

**Never** in Git, source files, the seed, docs, logs, error reports or image layers.

| Environment | Mechanism |
|---|---|
| development | `.env`, untracked, `.gitignore`d |
| CI | repository secrets; the workflow uses obvious non-secrets for the throwaway database |
| staging / production | the platform's secret store, injected as environment variables at runtime |

Secrets are injected **at runtime, never at build time**. The Dockerfile sets deliberately fake
values so `next build` can compile pages, and every one of them is refused by the production
guards — so an image that somehow ran with them would fail to start rather than run insecurely.

### Rotation

| Secret | When | Effect |
|---|---|---|
| `SESSION_SECRET` | on suspected compromise; annually | every session invalidated; everyone signs in again |
| Database password | on suspected compromise; annually | requires a restart with the new URL |
| `S3_*` | on suspected compromise; annually | evidence unreadable until updated; other workflows continue |
| `ANTHROPIC_API_KEY` | on suspected compromise | AI features fall back; the deterministic paths continue |

A secret that has ever been committed is compromised whether or not it is still in the working
tree. Rotate first, remove second.

---

## 4. What is never logged

Enforced centrally in `src/platform/observability/logger.ts`, because call sites are exactly
where it will be forgotten:

passwords and hashes · session tokens and cookies · API keys · connection strings · payment
evidence and anything read from a bank slip · transaction references · account numbers · raw
customer message text

Logs are shipped, indexed, retained for months and read by more people than the database is. A
customer's bank slip in a log aggregator is a disclosure that no amount of care elsewhere makes
up for.

---

## 5. `DEMO_MODE`

Permits `AI_PROVIDER=mock` and `FILE_STORAGE_DRIVER=local` under `APP_ENV=production`, for a
throwaway demonstration environment running a production build against fabricated data.

It does **not** permit the demo seed or a destructive reset — those key off `APP_ENV` alone and
have a second, independent check on whether the database looks remote.

Never set it for a deployment holding a real distributor's data. A screen implying a model read a
customer's message when a rule-based stub did is a lie the product tells its user.

---

## 6. Local setup

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET
pnpm db:up && pnpm prisma migrate deploy && pnpm db:seed && pnpm dev
```

The demo password is in `prisma/seed.ts` and is not a secret: it unlocks fabricated accounts in a
fabricated organization on a local container. It is refused in production by the same guard that
refuses the seed itself.
