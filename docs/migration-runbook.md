# Migration Runbook

Everything about changing the schema of a database a distributor's business depends on.

The claim this document refuses to make: **Prisma does not roll migrations back.** There is no
`migrate down`. Every recovery here is a forward fix or a restore.

---

## 1. How migrations are applied

`prisma migrate deploy`, and never `migrate dev`.

`migrate dev` is an interactive development command. It compares the schema against the database
and will offer to *reset* — dropping everything — when it finds drift. On a production database
that offer is one keystroke from the end of a business. `deploy` only applies pending migrations
in lexicographic order and fails if any has been modified since it was applied.

Migrations travel **inside the container image**, so a deploy runs exactly the migrations that
were built and tested with that code — not whatever happens to be on a branch.

They run as a **separate step before the new container serves traffic**, never at startup. With
more than one instance, startup migrations race; and a migration failure at startup is
indistinguishable from a crash loop.

They connect as the **owner** (`DIRECT_URL`). The application role has no migration privileges,
which is why a compromised application cannot alter the schema.

---

## 2. Before applying anything

```bash
git log --oneline -1                                        # what is being deployed
DATABASE_URL="$PROD_DIRECT_URL" pnpm prisma migrate status  # what is pending
pnpm ops:backup --label "pre-migration-$(git rev-parse --short HEAD)"
```

Check there is disk headroom: a migration that rewrites a table needs room for a second copy of
it, and PostgreSQL running out of space mid-`ALTER` is a bad afternoon.

Read every pending migration's SQL. Not skim — read.

---

## 3. Classifying a migration

This decides whether a code rollback will be available afterwards, so it is the most important
judgement in the process.

### Additive — safe

New table, new nullable column, new index, new enum value, new constraint that all existing rows
already satisfy.

The previous image still works against the new schema. A code rollback is genuinely available.

**Every migration in this repository so far is additive**, with two deliberate exceptions noted
below.

### Destructive — needs a plan

Dropping a column or table, renaming either, adding `NOT NULL` to a populated column, changing a
type, or a constraint existing rows might violate.

The previous image **will not work** against the new schema. A code rollback is not available,
and pretending otherwise during an incident is how a bad deploy becomes an outage.

Destructive changes go out as **expand and contract**, across two releases:

1. **Expand** — add the new shape, write to both, keep the old one. Deploy. Both images work.
2. **Contract** — once the old shape is provably unused, a later release removes it.

The two exceptions in this repository's history, both handled deliberately:

- `20260823090000` renamed `stock_adjustments` to `inventory_movements` and added columns. Written
  as a genuine `ALTER TABLE ... RENAME` rather than Prisma's generated drop-and-create, so the
  Phase 1 rows carried forward. 31 rows survived, verified.
- `20260824090200` dropped a unique index that contradicted an append-only grant. Dropping an
  index is reversible by recreating it and loses no data.

---

## 4. When a migration fails

**Do not re-run it.** Prisma records the failure; a second attempt will refuse and, if it did
proceed, would apply a partially-applied change twice.

```bash
DATABASE_URL="$PROD_DIRECT_URL" pnpm prisma migrate status
```

| State | What it means | What to do |
|---|---|---|
| Failed, nothing applied | The statement errored before changing anything | Fix the migration, commit, redeploy. Mark the failed one resolved: `prisma migrate resolve --rolled-back <name>` |
| Failed, partly applied | Some statements committed | **Restore from the backup.** PostgreSQL runs each migration in a transaction, so this is rare — but a migration containing `CREATE INDEX CONCURRENTLY` or multiple explicit transactions can reach it |
| Applied but wrong | It succeeded and did the wrong thing | Write a new migration that corrects it. Never edit an applied migration: the checksum changes and every future `deploy` refuses |

### Editing an applied migration

Do not. If it has already happened, `deploy` will fail with *"the migration was modified after it
was applied"* and the fix is to update the recorded checksum only when you are certain the
database already matches the corrected file:

```sql
UPDATE _prisma_migrations SET checksum = '<sha256 of the file>' WHERE migration_name = '<name>';
```

This was needed once during Phase 7, when a Phase 6 migration was corrected after being applied
to development. It is a repair for a mistake, not a technique.

---

## 5. Verifying

Automatically, on every push and before every release:

```bash
pnpm ops:verify-migrations --container <postgres-container>
```

Applies all 18 migrations to an **empty** database, then checks what migrations cannot express
and Prisma cannot see:

- RLS enabled *and* `FORCE`d on every table with an `organization_id`
- `distributor_app` is neither `SUPERUSER` nor `BYPASSRLS`
- `UPDATE` and `DELETE` revoked on `audit_events`, `inventory_movements`, `import_jobs`
- the three immutability triggers present
- 26 `tenant_isolation` policies

Latest run: **all checks passed, 18 migrations applied.**

This matters because the development database got its schema one migration at a time over nine
phases. A migration that only works because of what was already there passes every test until it
is run on something empty — which is the day a distributor's system is being set up.

---

## 6. Writing a new migration

```bash
pnpm prisma migrate dev --create-only --name descriptive_name
```

Then **read and edit the generated SQL**. Prisma's diff is a starting point, not an answer: it
cannot know a rename is a rename, and will happily drop and recreate a table full of data.

Conventions this repository follows:

- **RLS and constraints go in a separate migration, timestamped after** the one creating the
  tables. Phase 5 learned this the hard way: the RLS migration sorted *before* the table it
  secured, and a deploy against an empty database failed on a table that did not exist yet.
- **Every new tenant table gets `ENABLE` + `FORCE` RLS** and a `tenant_isolation` policy using
  `nullif(current_setting('app.organization_id', true), '')::uuid`. The `nullif` is load-bearing:
  without it a pooled connection whose GUC reverted to `''` raises a cast error instead of
  returning nothing.
- **Invariants that must not depend on application code go in the database.** Partial unique
  indexes, CHECKs, triggers. Application logic is the first line; these are what hold when two
  requests arrive in the same millisecond.
- **Append-only tables have `UPDATE` and `DELETE` revoked** from the application role.

Add the model to `TENANT_SCOPED_MODELS` in `src/platform/db/tenant.ts`. A coverage test reads the
Prisma DMMF and fails if a model with an `organization_id` is missing from that list, so a new
table cannot silently opt out of tenancy.
