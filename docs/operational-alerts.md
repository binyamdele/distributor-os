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

Storage is **warning at first, critical only when sustained**: quotations, orders, warehouse and
delivery all keep working when a bucket is unreachable, so it is a partial outage and paging at
minute one would train people to ignore it.

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

Minimum acceptable arrangement:

```bash
# In the nightly cron. Any non-zero exit reaches a person.
pnpm ops:backup --label nightly || notify "BACKUP FAILED on $(hostname)"

# Weekly, independently: is the newest dump less than 48 hours old?
find ./backups -name '*.dump' -mtime -2 | grep -q . || notify "NO RECENT BACKUP"
```

"Notify" can be an email, a Telegram message to the owner, or a line in a monitoring tool. What it
cannot be is a log file nobody opens.

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
