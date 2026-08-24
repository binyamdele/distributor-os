# Operational Alerts

The smallest set of alerts that would actually be acted on. Not a NOC — one pilot, one
distributor, and probably one person carrying the phone.

**The governing rule:** every alert here must be *actionable* and *rare*. An alert that fires
weekly and is dismissed weekly has trained somebody to dismiss it, and it will be dismissed on the
day it matters.

---

## Critical — wake somebody

| Alert | Condition | Why | First action |
|---|---|---|---|
| **Application down** | `/api/health/live` fails 3× over 3 min | The distributor cannot work | Restart; check the platform's status |
| **Not ready** | `/api/health/ready` returns 503 for 5 min | Serving errors or about to | Read the failing check in the body |
| **Database unreachable** | readiness `database` check failed | Everything stops | Check the managed database's health and connection count |
| **Repeated 500s** | > 10 unhandled errors in 5 min | A release has broken something | Take a correlation id from the logs and trace it; consider rolling back |
| **Storage unavailable > 15 min** | readiness `file-store` degraded, sustained | Payment evidence cannot be uploaded or read | Check bucket credentials and the provider |

The first four are raised by `ops:check-readiness`, which polls `/api/health/ready` on a schedule
and names the failing dependency in the alert. It distinguishes two states that look alike and
are not: a **503** means the application answered and told the truth about itself, while
**unreachable** means nobody answered at all — the process, the host or the network. The second
is the state where silence is most likely to be mistaken for health, so it is always critical.

**Repeated 500s is not covered by anything in this repository.** It needs log aggregation, which
the pilot does not have; `ERROR_REPORTING_DSN` pointed at Sentry is the intended answer, and its
alerting rules live there rather than here. Saying so is better than listing it as though a cron
job were watching.

Storage is **warning at first, critical only when sustained**: quotations, orders, warehouse and
delivery all keep working when a bucket is unreachable, so it is a partial outage and paging at
minute one would train people to ignore it.

One exception, and it is deliberate. **A production deployment configured for S3 has declared the
evidence store to be required**, so readiness reports not-ready as soon as the bucket stops
answering rather than serving traffic that cannot complete a payment. In that configuration the
"Not ready" row above fires first and this row never gets the chance to — which is the intent: a
load balancer should stop sending payment traffic to a container that cannot store evidence.

---

## Warning — look at it today

| Alert | Condition | Why |
|---|---|---|
| **Backup failed** | the nightly job exits non-zero | See §"Backups" — this is the one that matters most |
| **Backup stale** | newest dump older than 48 hours | Catches the schedule silently not running at all, which no failure alert can |
| **Migration failed** | `prisma migrate deploy` exits non-zero | Deploy is half-done; nothing should be serving |
| **Elevated errors** | error rate > 1% over 15 min | Something is degrading |
| **Slow responses** | p95 > 5 s over 15 min | Usually pool exhaustion or a missing index |
| **Rate limiting active** | > 50 login rejections in an hour | Either an attack or somebody genuinely locked out |

---

## Backups

**A backup silently failing for thirty days is not a backup system.**

Two alerts, and both are needed because they catch different failures:

1. **The job failed** — it ran and something went wrong.
2. **No recent backup exists** — it never ran at all. A failure alert cannot detect this, because
   a job that does not run produces no failure.

Both are now implemented rather than described. `ops:backup` raises the first itself — every exit
path that means "no backup was taken" delivers an alert before the process ends — and
`ops:check-backup-freshness` raises the second.

```
0 2 * * *   cd /srv/distributor-os && pnpm ops:backup --label nightly
0 8 * * *   cd /srv/distributor-os && pnpm ops:check-backup-freshness --max-age-hours 48
*/5 * * * * cd /srv/distributor-os && pnpm ops:check-readiness --base-url https://<host> --quiet-when-healthy
```

**Run these from a different machine or scheduler than the application.** A checker sharing a
machine with the thing it checks dies with it, and the failures they exist to detect — "the
scheduler stopped", "the host is gone" — are exactly the ones that take the checker down too.

The freshness check verifies the newest dump against its recorded SHA-256 as well as its age,
because a dump truncated by a full disk has a recent timestamp and a plausible size.

---

## Where alerts go

Telegram is the intended human-visible destination for the pilot: the owner and whoever carries
the phone are already on it, it needs no workspace administration, and a phone notification at
2 a.m. is the entire point.

```
TELEGRAM_BOT_TOKEN     # from @BotFather
TELEGRAM_CHAT_ID       # the chat or channel the bot posts to
```

Both halves, or Telegram is not configured at all. `ALERT_WEBHOOK_URL` remains available for
Slack, Discord, Google Chat or anything else that accepts a JSON POST, and both can be set at
once.

Every alert is **also** appended to `./backups/alerts.log`, first and always, so an outage at the
destination cannot swallow the notice it was reporting.

```bash
pnpm ops:notify --test   # exits non-zero unless a *person* was actually reached
```

That exit code is deliberate. It used to be satisfied by the local file write, which always
succeeds — so the test passed on a machine with no destination configured at all, which is
precisely the state it exists to detect. A test that cannot fail is not a test.

### Why Telegram has its own adapter

It does not fit the generic webhook, and forcing it would have been the wrong kind of clever:

- `sendMessage` **requires a `chat_id`**. The generic sink posts `{text, ...alert}` and has
  nowhere to put one, so an authenticated request would be rejected for a missing field.
- The bot token is a **path segment** of the request URL. Reusing `ALERT_WEBHOOK_URL` would mean
  keeping a bot token in a variable that gets pasted into runbooks and issue reports.

So `AlertSink` has three implementations — file, webhook, Telegram — each responsible for its own
request shape, its own success test, and for describing itself in a way that is safe to print.
Nothing that reaches a cron log or an evidence report ever contains a token, a full URL or a
recipient address; the Telegram sink identifies itself as `telegram (chat …7890)`, which is
enough to tell two configured destinations apart and no more.

Messages are sent as **plain text with no `parse_mode`**. Telegram's MarkdownV2 requires escaping
`_ * [ ] ( ) ~ \` > # + - = | { } . !`, and an unescaped one is a 400 rather than a formatting
glitch. Alert details carry file paths, exit codes and `pg_dump` output, which are full of
exactly those characters. An alert that fails to send because a hyphen appeared in an error
message is worse than an alert without bold text.

**Until `pnpm ops:notify --test` has actually arrived on somebody's phone, the alerting is a
mechanism and not a safety net.** That is a launch-gate item, not a nicety.

---

## What is deliberately not alerted

| | Why |
|---|---|
| Individual 4xx responses | A user mistyping a password is not an incident |
| AI provider failures | Optional by design. Everything falls back to a deterministic path, so a provider outage is a quality reduction and not an operational one |
| Slow AI calls | Somebody else's network. Never on the critical path |
| Low stock | A business condition the dashboard shows. Alerting on it would page somebody about cement |
| Failed deliveries | An operational exception with a workflow. It belongs in Needs Attention, not on a phone at night |

That last distinction is the important one: **business conditions belong on the dashboard, system
failures belong in an alert.** Mixing them produces a phone that buzzes about cement and gets
silenced before the night the database dies.

---

## Uptime checking

An external check — outside the platform running the application, or it goes down with it.

- `GET /api/health/ready` every 60 s from at least one location
- 3 consecutive failures before alerting, so a single blip is not a page
- 10 s timeout

Both endpoints are unauthenticated by design and deliberately expose nothing: liveness returns
`{"status":"alive"}`, readiness returns check names and latencies with no host, path, connection
string or exception message.

---

## During an incident

1. `curl https://<host>/api/version` — know what is deployed
2. `curl https://<host>/api/health/ready` — know which dependency is unhappy
3. Filter logs by `correlationId` from any user report
4. If a deploy caused it, follow [`deployment-runbook.md`](deployment-runbook.md) §8 — and note
   that a code rollback is only safe if the migrations were additive
5. If data is wrong, [`backup-and-restore-runbook.md`](backup-and-restore-runbook.md) §6 —
   restore into a **new** database; the damaged one is evidence
6. Record it in [`pilot-issue-template.md`](pilot-issue-template.md)
