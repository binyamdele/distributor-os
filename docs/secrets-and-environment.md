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
| `ERROR_REPORTING_DSN` | — | A Sentry DSN sends server exceptions there. Absent means log-only, which is a workable pilot position. Anything that is not a Sentry DSN logs a warning once and falls back to logging, rather than silently doing nothing |
| `RATE_LIMIT_ENABLED` | `true` | Opt-*out*, so switching it off during an incident is a visible act |
| `LOG_LEVEL` | `info` (`debug` in development) | |
| `DEMO_MODE` | `false` | The one escape hatch, and it is narrow — see §6 |

### Read by the operational scripts, not by the application

These are never parsed by the config schema and can never stop the application from starting.
That separation is deliberate: a typo in an alerting variable should not take a distributor's
system offline.

| Variable | Used by | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `ops:notify`, `ops:backup`, `ops:check-*` | Bot token from @BotFather. **Never logged**, never printed, and never included in a delivery result |
| `TELEGRAM_CHAT_ID` | as above | The chat or channel the alert goes to. Only the last four characters are ever printed |
| `ALERT_WEBHOOK_URL` | as above | Slack/Discord/Google Chat incoming webhook. Only the host is ever printed — the path carries the secret |
| `ALERT_LOG_PATH` | as above | Default `./backups/alerts.log`. The fallback-of-record, written before any network call |

Both halves of the Telegram pair are required; one alone configures nothing.

---

## 3. The host checklist

Every variable a container host must be given, **names only**. This is the list to paste into a
platform's secret manager, and the reason it exists is that a half-configured deployment now
refuses to start rather than coming up broken — so a missing name here is a failed release.

```
# identity and build
APP_ENV=production
NODE_ENV=production            # set by the image; listed because platforms sometimes override it
APP_URL                        # https:// — startup refuses http in production
BUILD_SHA                      # injected at image build; startup refuses "unknown"
BUILD_TIME                     # injected at image build

# database — two roles, and the separation is the tenancy guarantee
DATABASE_URL                   # distributor_app: NOSUPERUSER, NOBYPASSRLS
DIRECT_URL                     # owner/admin: migrations and backups only, never the runtime

# sessions
SESSION_SECRET                 # 32+ generated characters

# evidence storage
FILE_STORAGE_DRIVER=s3         # "local" is refused in production
S3_ENDPOINT                    # required for anything that is not AWS
S3_REGION
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
S3_FORCE_PATH_STYLE=true       # required by Supabase Storage and by MinIO

# AI
AI_PROVIDER                    # "anthropic" or "disabled"; "mock" is refused in production
ANTHROPIC_API_KEY              # only when AI_PROVIDER=anthropic

# error reporting (optional)
ERROR_REPORTING_DSN            # a Sentry DSN, or unset for log-only

# alerting — on whichever machine runs the scheduled jobs, not necessarily the app host
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ALERT_WEBHOOK_URL              # optional alternative or addition
```

Deliberately absent: anything named `NEXT_PUBLIC_*`. Next inlines those into the client bundle at
build time, with no runtime guard — `tests/security/evidence-boundary.test.ts` fails the build if
a secret-shaped name ever acquires that prefix.

---

## 4. Where secrets live

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

### The staging rotation that is owed

**The Supabase staging credentials were exposed during manual setup and must be rotated before
any real distributor data is permitted.** Not "should" — this is a launch-gate item, and it is
tracked as one in [`pilot-launch-gate.md`](pilot-launch-gate.md).

Exposure during setup is ordinary. A connection string gets pasted into a terminal that logs to a
scrollback file, a key is read aloud, a screenshot is taken. None of that is negligence; what
would be negligent is carrying those credentials forward into an environment holding a real
distributor's payment records, because the pilot is the moment the value of a leaked credential
changes from nothing to somebody's commercial history.

Rotate in this order, because each step invalidates what the one before it used:

1. **Supabase database admin/migration password** — the `DIRECT_URL` role.
2. **`distributor_app` password** — the runtime role. Change it in the database, then in the
   runtime secret store; the application must be restarted with the new value.
3. **S3 access key pair** — revoke the old pair rather than leaving it active alongside the new
   one. An unused-but-valid key is a key.
4. **`SESSION_SECRET`** — if the staging value was ever displayed. Every session is invalidated,
   which on staging costs one sign-in.
5. **Update the runtime secret store**, and only then restart.

Then prove the rotation landed, rather than assuming it:

```bash
pnpm ops:verify-deployment --base-url https://<staging-host> --expect-env staging
pnpm test:storage        # with TEST_S3_* pointed at the new key pair
```

Readiness green after a rotation is the only evidence that the new credentials actually work.
Readiness green *before* a rotation proves nothing about it — which is why the order matters.

**Do not put the old or new values in any document, ticket, or commit message**, including this
one. The names above are the whole of what belongs in writing.

---

## 5. What is never logged

Enforced centrally in `src/platform/observability/logger.ts`, because call sites are exactly
where it will be forgotten:

passwords and hashes · session tokens and cookies · API keys · connection strings · payment
evidence and anything read from a bank slip · transaction references · account numbers · raw
customer message text

Logs are shipped, indexed, retained for months and read by more people than the database is. A
customer's bank slip in a log aggregator is a disclosure that no amount of care elsewhere makes
up for.

---

## 6. `DEMO_MODE`

Permits `AI_PROVIDER=mock` and `FILE_STORAGE_DRIVER=local` under `APP_ENV=production`, for a
throwaway demonstration environment running a production build against fabricated data.

It does **not** permit the demo seed or a destructive reset — those key off `APP_ENV` alone and
have a second, independent check on whether the database looks remote.

Never set it for a deployment holding a real distributor's data. A screen implying a model read a
customer's message when a rule-based stub did is a lie the product tells its user.

---

## 7. Local setup

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # SESSION_SECRET
pnpm db:up && pnpm prisma migrate deploy && pnpm db:seed && pnpm dev
```

The demo password is in `prisma/seed.ts` and is not a secret: it unlocks fabricated accounts in a
fabricated organization on a local container. It is refused in production by the same guard that
refuses the seed itself.
