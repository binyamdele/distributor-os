# Supabase Staging

The staging environment, what it is verified to do, and what it deliberately is not.

Supabase provides two things here and nothing else: **managed PostgreSQL 17** and an
**S3-compatible private bucket** for payment evidence. It is infrastructure, in the same sense
that a VM and a disk are infrastructure.

---

## 1. What is deliberately not used

| Supabase feature | Why not |
|---|---|
| Supabase Auth | Sessions, RBAC and the five roles are the product's own, tested across seven phases. Two identity systems is one too many, and the second one always ends up authoritative by accident |
| Client-side database access | Every query would leave the server, and the tenancy guarantee would move from the application to a set of policies written in someone else's dialect |
| PostgREST for business logic | Order acceptance takes row locks in a specific order to make concurrent reservations safe. That is not expressible as REST over tables |
| Supabase's RLS conventions | The existing policies are `FORCE`d, enumerated by a schema-coverage test, and depend on `app.organization_id`. Rewriting them to a different convention would mean re-proving the whole tenancy story for no gain |
| Supabase Storage RLS | Meaningless here — see §4. The application is the boundary |

**Prisma, the 18 existing migrations, `distributor_app`, `FORCE` RLS, the custom RBAC and the
transaction/row-lock architecture are unchanged.** Nothing in the codebase names Supabase; it is
reached entirely through `DATABASE_URL`, `DIRECT_URL` and the `S3_*` settings, which is what
makes it swappable for any managed PostgreSQL and any S3-compatible bucket.

---

## 2. Connection roles

Two connections, and the separation is the tenancy guarantee rather than a convention.

| Setting | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `distributor_app` — `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` | The application, always |
| `DIRECT_URL` | Supabase admin/migration role | `prisma migrate deploy`, `ops:backup`. Never the runtime |

RLS policies do not apply to a superuser, and `BYPASSRLS` is exactly what it sounds like. A
deployment that connects with the admin string has **no tenant isolation whatsoever** and behaves
identically in every other respect — every page renders, every test passes, and every
organization can read every other's data.

That is why `ops:verify-deployment` connects with the *application's* connection string and
asserts the role's attributes directly. A verification run as the admin would pass while the
application ran as something else entirely.

### Pooler choice

`DIRECT_URL` must be the **direct connection or the session pooler**, never the transaction
pooler:

- `prisma migrate deploy` needs session state and advisory locks
- `pg_dump` needs a stable session and consistent snapshot

The transaction pooler recycles connections between statements, which is precisely the model the
concurrency design in Phases 4–7 was chosen to avoid. `DATABASE_URL` may use the session pooler;
it must not use the transaction pooler, for the same reason.

---

## 3. Storage compatibility

`S3FileStore` was built and proven against MinIO. Supabase Storage speaks the same protocol, but
"speaks the same protocol" is a claim to test rather than assume — three real defects came out of
asking MinIO rather than a mock, and a second provider is a second opportunity for the same
thing.

**One command answers all of it**, against whichever provider it is pointed at:

```bash
TEST_S3_ENDPOINT="https://<project>.supabase.co/storage/v1/s3" \
TEST_S3_REGION="eu-west-1" \
TEST_S3_BUCKET="distributor-evidence-staging" \
TEST_S3_ACCESS_KEY_ID="…" \
TEST_S3_SECRET_ACCESS_KEY="…" \
pnpm test:storage
```

That runs the storage contract suite, the application evidence lifecycle and the boundary checks
— 42 assertions covering every capability the application uses:

| Capability | Where it is used | What the suite asserts |
|---|---|---|
| Path-style addressing | Required by Supabase and MinIO; `S3_FORCE_PATH_STYLE=true` | Every operation, implicitly — nothing works without it |
| `PutObject` with user metadata | Evidence upload; the content hash travels with the object | The hash comes back from a later `HeadObject` unchanged |
| `HeadObject` | `getMetadata` | Size and hash without downloading the object |
| `GetObject` | The authenticated read route | Bytes are byte-identical, including binary PNG/JPEG |
| `DeleteObject` | Retention | The object is gone afterwards, and deleting a missing one is not an error |
| `HeadBucket` | `health()`, which readiness depends on | Reachable is reported as reachable; wrong credentials as `unauthorized`; a missing bucket as `missing-bucket` |
| Missing-key behaviour | Every read | `null`, not an exception — the local store and S3 must agree |
| Malformed-key behaviour | Defence in depth | `null` without a network call |
| Timeout behaviour | A provider that stops answering | Bounded, and reported as `timeout` rather than hanging |

### Server-side encryption

**Leave `S3_SERVER_SIDE_ENCRYPTION` unset.** The adapter sends no encryption header by default,
and that default was earned: an earlier version sent `AES256` unconditionally on the assumption
that a provider without support would ignore it. MinIO refuses the upload outright — "KMS is not
configured" — which would have failed *every* evidence upload.

Supabase encrypts at rest as a property of the platform, so there is nothing to ask for. Set the
flag only for a provider that demands the header explicitly.

### `health()` depends on `HeadBucket`

Worth stating plainly because readiness depends on it, and in production a degraded store is a
503: if a provider does not implement `HeadBucket`, a perfectly good bucket reports itself
unreachable and the deployment refuses traffic. Supabase implements it — confirmed by the running
application reporting the store healthy — and the suite above is what would catch a provider that
does not.

---

## 4. The trust boundary

**Supabase's server-side S3 credentials bypass Storage RLS.** A key with `GetObject` on the
bucket can read every object in it, for every tenant, whatever policies are configured in the
dashboard. That is not a flaw to work around; it is what a server-side key is.

So the provider's access control is **not** the boundary. The application is. Evidence is
protected by exactly three things:

1. **The credentials never leave the server.** No `NEXT_PUBLIC_*` name may hold a secret — Next
   inlines those into the client bundle at build time with no runtime guard. Asserted by test.
2. **The bucket is private.** An anonymous request for an object path is refused, and so is an
   anonymous listing. Asserted by test, against the real bucket.
3. **Every read passes session, permission and tenant checks first.** The store interface has no
   URL method at all, so no presigned link can be handed out by accident — a presigned URL is a
   bearer token for a bank slip, and once issued it works for anybody holding it, for as long as
   it lives, and cannot be revoked.

A file identifier is worth nothing on its own: a valid id from the wrong tenant, a malformed id
and one that was never issued all produce the same answer, so the response cannot be used to
confirm that a file exists.

`tests/security/evidence-boundary.test.ts` asserts 1 and 2, because they are properties of the
build and the bucket rather than of any function — nothing else would notice them changing.

---

## 5. Backup and restore

**Supabase's own managed backups do not satisfy the restore gate.** They are worth having and
they are not evidence: a backup nobody has restored is a belief, and the recovery this product
needs spans two systems that Supabase backs up separately — the database and the evidence bucket.

### The database

`ops:backup` works against Supabase, with one requirement and one behaviour worth knowing.

The requirement is `pg_dump` **17 or newer**, because dumping a server newer than the client is
refused. If the machine running the backup has no `pg_dump`, pass `--container` and the script
borrows one from a local PostgreSQL container:

```bash
pnpm ops:backup --label staging --container distributor-os-postgres
```

The behaviour: the script decides what to dump from the **host in the connection string**. A
loopback host means the container *is* the database; anything else means the container is only
being borrowed as a client and the full connection string is passed through — including
`sslmode=require`, without which a managed provider refuses the connection.

That distinction was a defect, and a quiet one. The previous version always discarded the host
and dumped whatever the local container held. Point `DIRECT_URL` at Supabase, pass `--container`
because the host has no `pg_dump`, and it would usually fail on an unknown role — but where the
local container happened to have a role and database of the same names, it *succeeded*, and wrote
the wrong database out under a filename and checksum implying it was the staging backup.

Dumps are scoped to `--schema=public`. On a managed provider the database is shared with the
provider's own machinery — Supabase adds `auth`, `storage`, `realtime`, `graphql` and
`extensions`, owned by roles that exist nowhere else. An unscoped dump drags all of it along and
then fails to restore into a plain PostgreSQL 17, which is exactly what the restore drill
restores into. Scoping also means the backup holds no copy of the provider's auth tables, which
is a smaller and better thing to be holding.

### The evidence files

**A database backup is not evidence recovery.** The database holds the storage key and the
content hash; the bytes are in the bucket. Restore the database alone and every payment row
points at a file that may no longer exist — and the one thing a payment dispute turns on is the
slip.

For the pilot, the proportionate arrangement is a scheduled copy to a *second* private
destination, in a different account or provider:

```bash
# Nightly, after the database backup. rclone speaks S3 to both ends.
rclone sync staging:distributor-evidence-staging backup:distributor-evidence-mirror \
  --immutable --stats-one-line
```

`--immutable` matters: it fails rather than propagating a change to a file that should never
change. Evidence is write-once by design, so a modified object is a signal, not something to
mirror faithfully.

Three properties make this worth doing at all, and the third is the one usually skipped:

1. **A different account.** A mirror inside the same project dies with the project.
2. **Versioning on the primary bucket**, so an overwrite or delete is recoverable in place.
3. **Verified restores.** `ops:restore-drill` reads every evidence file the restored database
   references and compares its bytes against the hash recorded in the row. The mirror is only a
   backup once that check has passed against it.

Bucket versioning and a healthy primary are **not** storage recovery, and must not be recorded as
such. The drill is what turns them into it.

### The drill

```bash
pnpm ops:backup --label pre-pilot --container <container>
pnpm ops:restore-drill --dump ./backups/<file>.dump --container <container>
```

It verifies the dump against its recorded checksum first, restores into an isolated scratch
database it drops afterwards, compares 23 business facts spanning every phase, and then checks
every referenced evidence file for presence and hash. **A restore into the same environment is
not the drill the gate requires** — the gate requires restoring into a *separate* environment,
which needs a second project or host that does not yet exist.

---

## 6. What is verified, and by what

| | Verified by |
|---|---|
| Migrations applied, none pending | `ops:verify-deployment`, over the application's own connection |
| Runtime role is `distributor_app`, not superuser, no `BYPASSRLS` | as above |
| RLS enabled *and* `FORCE`d on all 26 tenant tables | as above |
| Append-only grants revoked | as above |
| Liveness, readiness, served commit, environment | as above |
| HTTPS | as above — a loopback address is exempt and says so |
| Storage: every capability the application uses | `pnpm test:storage` against the staging endpoint |
| Evidence lifecycle through the application | included in the above |
| Bucket privacy, no client-side credentials | included in the above |
| Alert destinations configured | reported by `ops:verify-deployment`; delivery proved by `ops:notify --test` |

Nothing in that table is satisfied by reading a dashboard. Each row is a command that either
passes or does not.
