# Backup and Restore Runbook

**A backup that has never been restored is a hypothesis.** This document exists because that
sentence is the difference between believing you have backups and having them.

The drill in §4 has been performed. Its evidence is in §5.

---

## 1. What has to survive

Two stores, and a restore of either alone is incomplete.

| Store | Contents | Loss means |
|---|---|---|
| **PostgreSQL** | every quotation, order, payment, reservation, movement, delivery, return and audit event | the distributor's entire commercial history |
| **Object storage** | payment evidence — bank slips and transfer screenshots | payment rows referencing proof that no longer exists, which is a dispute already lost |

The database records a `content_hash` for every evidence file. That makes a mismatch between the
two stores **detectable**, and §4 is what detects it.

---

## 2. Taking a backup

```bash
pnpm ops:backup --label nightly
# or, when pg_dump is not installed on the host:
pnpm ops:backup --container distributor-os-postgres --label nightly
```

Produces `backups/<database>-<label>-<timestamp>.dump` and a `.sha256` beside it.

**`pg_dump --format=custom`**, for three reasons that matter during a restore rather than during
a backup: it is compressed; `pg_restore` can read it selectively, which is what makes "restore
just this table" possible at 2 a.m.; and `pg_restore --list` can inspect it without restoring.

**Taken as the owner (`DIRECT_URL`), never as the application role.** RLS is `FORCE`d, so a dump
taken as `distributor_app` outside a tenant context would contain *no rows at all* — and would
look like a perfectly successful backup.

**The checksum is not decoration.** A truncated dump is worse than no dump, because it is
discovered only when it is the last thing standing.

### Scheduling

For the pilot, a cron on the host or the platform's scheduler:

```
0 2 * * *  cd /srv/distributor-os && pnpm ops:backup --label nightly >> /var/log/backup.log 2>&1
```

Retention: **7 daily, 4 weekly, 6 monthly**. Enough to recover from a mistake noticed a week
later; short enough that the storage bill stays trivial. Older dumps are deleted by the same
schedule.

Backups must be **encrypted at rest and stored off the application host**. A dump sitting beside
the database it came from does not survive the failure it exists for.

### Making a failed backup visible

**A backup silently failing for thirty days is not a backup system.** Whatever runs the schedule
must alert a human on failure. The minimum acceptable arrangement is a scheduled job whose
non-zero exit is delivered somewhere a person reads, plus a weekly check that the newest dump is
less than 48 hours old. See [`docs/operational-alerts.md`](operational-alerts.md).

---

## 3. Object storage

Payment evidence lives in an S3-compatible bucket in production (local disk in development, which
the production config refuses precisely because container filesystems are ephemeral).

Recovery relies on **bucket versioning plus a lifecycle policy**, not on a copy job:

- versioning on, so an overwrite or delete is recoverable
- a deny policy on public access
- the same retention window as the database, so a database restored to Tuesday finds evidence as
  it was on Tuesday

**This is a production-configuration guarantee, not something this repository can prove.** What
*is* proven is detection: §4 step 5 verifies every restored payment row against the actual bytes,
by hash.

---

## 4. The restore drill

```bash
pnpm ops:restore-drill --dump ./backups/<file>.dump --container distributor-os-postgres
```

What it does:

1. verifies the dump against its recorded checksum — a corrupt backup fails here, not later
2. reads 23 facts from the live database: counts across every phase's tables, plus one specific
   order's number, total and payment status, plus the total physical stock
3. creates a scratch database and restores into it
4. reads the same 23 facts back and compares them
5. checks every evidence file the restored payment rows reference, by content hash
6. drops the scratch database

Step 2 uses specific values rather than only counts, because **a count can match while every row
is wrong**. Step 5 is the one that gets forgotten, and it is the one that catches the failure
mode nobody expects.

---

## 5. Drill evidence

Performed against the development database, 2026-08-23.

```
=== Restore drill ===

  Checksum verified: e61acef128968519…
  Read 23 facts from "distributor_os".
  Creating scratch database "distributor_os_restore_drill"…
  Restoring…

  Fact                          live            restored
  --------------------------------------------------------------
  organizations                 3               3               ok
  users                         7               7               ok
  customers                     101             101             ok
  products                      49              49              ok
  quotations                    4505            4505            ok
  salesOrders                   1135            1135            ok
  payments                      788             788             ok
  confirmedPayments             739             739             ok
  confirmedPaymentTotalMinor    3482129850      3482129850      ok
  stockReservations             335             335             ok
  activeReservations            224             224             ok
  consumedReservations          90              90              ok
  inventoryMovements            107             107             ok
  warehouseTasks                105             105             ok
  deliveries                    61              61              ok
  returns                       2               2               ok
  discrepancies                 17              17              ok
  auditEvents                   11668           11668           ok
  sampleOrderNumber             SO-2026-05011   SO-2026-05011   ok
  sampleOrderTotalMinor         40411000        40411000        ok
  sampleOrderPaymentStatus      PARTIALLY_PAID  PARTIALLY_PAID  ok
  totalAvailableStock           67660           67660           ok
  evidenceFiles                 408             408             ok

  Evidence files referenced by the restored database: 408
    present and hash-verified   408
    missing from the store      0
    present but hash mismatch   0

  RESTORE VERIFIED — every fact matched.
```

**What this proves:** a dump taken by `pnpm ops:backup` restores to a byte-identical business
position, including exact money totals (ETB 34,821,298.50 across 739 confirmed payments), the
reservation lifecycle, 11,668 audit events, and 408 evidence files whose contents still hash to
what the database says they should.

**What it does not prove:** that a *production* backup restores. The mechanism is identical and
the drill must be repeated against production before go-live and quarterly thereafter. See §7.

---

## 6. Restoring for real

When this is not a drill, the order matters.

```bash
# 1. STOP THE APPLICATION FIRST.
#    A running container writing into a database being restored produces a state that matches
#    neither the backup nor what was there before.

# 2. Verify the dump before touching anything.
sha256sum -c backups/<file>.dump.sha256

# 3. Restore into a NEW database, never over the damaged one.
#    The damaged database is evidence. Overwriting it destroys the only record of what happened,
#    and the restore may itself turn out to be wrong.
createdb -O <owner> distributor_os_restored
pg_restore --username <owner> --dbname distributor_os_restored --no-owner --no-privileges <file>.dump

# 4. Provision the application role's grants (the dump carries no privileges).
psql -d distributor_os_restored -f docker/init-test-db.sql   # the GRANT section

# 5. Verify before cutting over.
pnpm ops:restore-drill --dump <file>.dump --container <container>

# 6. Point DATABASE_URL and DIRECT_URL at the restored database, then start the application.

# 7. Check readiness and the deployed version.
curl -fsS https://<host>/api/health/ready
curl -fsS https://<host>/api/version
```

**Then reconcile the evidence store.** If the drill reported missing files, restore the bucket to
the same point in time before telling anyone the system is back: payment records without their
proof look complete and are not.

---

## 7. Cadence

| When | What |
|---|---|
| nightly | automated backup, alert on failure |
| weekly | confirm the newest dump is < 48 hours old |
| before every production deploy | manual backup (`--label pre-deploy-<sha>`) |
| **before go-live** | full restore drill against production |
| quarterly | full restore drill against production |
| after any schema-changing release | restore drill, because a dump's usefulness depends on the schema it came from |

---

## 8. Honest limits

- **Point-in-time recovery is not configured.** The recovery point is the last nightly dump, so
  the worst case is losing a day's work. PITR via WAL archiving is the upgrade, and it is a
  managed-provider feature rather than something this repository sets up.
- **The drill has been run against development data only.** The mechanism is identical; the
  claim is not, and it is listed as a pre-launch blocker rather than quietly assumed.
- **Object-store recovery is a configuration guarantee**, not one this repository proves. What is
  proven is that a mismatch is detected rather than silently tolerated.
- **Restore time has not been measured at production scale.** The development dump is 1.68 MB and
  restores in seconds; a distributor with a year of history will be larger, and the number should
  be measured during the pre-launch drill rather than guessed at here.
