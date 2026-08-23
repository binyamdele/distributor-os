# Pilot Readiness

Where this system actually stands for one real distributor.

**READY** — done, and there is evidence.
**PARTIAL** — works, with a stated limitation.
**BLOCKED** — must be done before real data goes in.

No percentage. A single number would compress ten unlike things into one, and the two BLOCKED
rows are not offset by ten READY ones — they are the whole question.

---

## 1. Application functionality — **READY**

Inquiry → parse → review → quotation → approval → send → follow-up → acceptance → order → stock
reservation → payment evidence → Finance confirmation → warehouse task → pick → handover → stock
consumption → delivery or collection → completion → dashboard, with exception paths for inventory
discrepancies, failed deliveries, retries and returns.

**Evidence:** 1,006 unit tests, 491 integration tests against real PostgreSQL 17, 187 Playwright
specs across desktop and mobile.

Money is integer minor units end to end. Reporting boundaries are computed in the organization's
timezone, tested across daylight-saving transitions in two hemispheres.

---

## 2. Security — **PARTIAL**

Authorization, RLS, IDOR, mass assignment, CSRF, XSS, SQL injection, path traversal, upload
handling, secret leakage, cookies and error verbosity: all reviewed with evidence in
[`phase-9-security-review.md`](phase-9-security-review.md).

Rate limiting on login, AI calls and uploads. scrypt password hashing. Sessions revoked
server-side on logout, verified by replaying a copied cookie.

**Limitation:** no independent penetration test. This is a structured self-review by the person
who wrote the code, which is a weaker thing. Recommended before or shortly after go-live.

**Dependency audit:** 11 advisories, every one in build or test tooling and none reachable from
the production container. Classified individually in the review; no upgrades performed, because
resolving them needs major-version bumps of Next, Prisma and Vitest and taking those days before
a pilot risks more than it fixes.

---

## 3. Tenancy — **READY**

Three layers: a Prisma extension injecting `organizationId`, RLS `ENABLE`d and `FORCE`d on all 26
tenant tables, and tests that enumerate the DMMF so a new table cannot silently opt out.

The property it all rests on is now asserted on a freshly built database, in CI:

```
ok    RLS enabled and FORCED on every tenant table
ok    "distributor_app" is neither superuser nor BYPASSRLS
ok    tenant_isolation policies present (26)
```

Cross-tenant isolation is proven for reads, writes, aggregates, attention queues, imports and
file access. A foreign id, a malformed id and a nonexistent id all return the same 404.

---

## 4. Recoverability — **PARTIAL**

**The restore drill has been performed and passed.** 23 facts compared across every phase's
tables — 4,505 quotations, 1,135 orders, ETB 34,821,298.50 across 739 confirmed payments, 11,668
audit events — every one matched, plus 408 evidence files present and hash-verified. Transcript in
[`backup-and-restore-runbook.md`](backup-and-restore-runbook.md) §5.

Backup is checksummed; a corrupt dump fails the drill rather than the emergency.

**Limitations:**
- the drill ran against **development** data. The mechanism is identical; the claim is not
- **no point-in-time recovery** — the recovery point is the last nightly dump
- scheduling and off-host encrypted storage are production configuration, not repository code
- object-store recovery is a bucket-versioning guarantee; what is *proven* is that a mismatch is
  detected rather than silently tolerated

---

## 5. Deployment — **PARTIAL**

Dockerfile (multi-stage, non-root, tini, healthcheck, build SHA baked in), `.dockerignore`, a
runbook written for somebody who did not build this, and a documented rollback policy that
refuses to promise automatic database rollback because Prisma has none.

All 18 migrations replay onto an empty database, verified in CI.

**Limitation — and it is the honest one: nothing has been deployed.** Everything above has been
written and locally verified. The first execution of the runbook against a live host will be the
first. Treat it as an exercise with nobody depending on it.

**The S3 storage adapter is specified and not implemented.** The `FileStore` interface has no URL
method and the production config already refuses local storage, so the seam is right — but the
adapter itself is a remaining task, listed as BLOCKED in §11.

---

## 6. Observability — **READY**

Liveness (touches nothing, so a database blip cannot cause a restart storm), readiness (database,
migrations, file store, with the store degrading rather than failing), and a version endpoint.

Correlation ids assigned in middleware, carried across await boundaries, echoed on every response.
Structured JSON logs with central redaction — credentials, tokens, payment evidence, bank
references and raw customer text, asserted by test. Error reporter behind an adapter; log-only by
default, which is honest about what it is.

`no-console` is an ESLint error across `src/`, so the redaction is a control rather than a
convention.

---

## 7. Onboarding — **READY**

`admin:create-organization` creates exactly four rows and prints a generated password once.
`admin:import` loads customers, products and opening stock with preview, all-or-nothing commit and
idempotency. Sequence in [`pilot-onboarding.md`](pilot-onboarding.md); four role guides written.

---

## 8. Data migration — **READY**

CSV templates with explicit columns. Preview before commit, every error with a line number.
All-or-nothing per file. Opening stock cannot be applied twice — guarded by content fingerprint
*and* by a refusal to set a balance on a product that already holds stock, because those catch
different mistakes. Each opening balance writes an `OPENING_BALANCE` movement, so the ledger can
explain every quantity from day one.

**Evidence:** 48 unit tests on the parsing rules, 17 integration tests on the commit path
including rollback and cross-tenant isolation.

---

## 9. Operational support — **PARTIAL**

Alert definitions, an issue template with a classification scheme, a retention and privacy
document, and a load test: **0% error rate, 518 requests at 15 concurrent users**, p50 38–1642 ms
by operation.

**Limitations:** alert delivery is not wired to a destination — that belongs to whoever owns the
production account; and nobody is yet named as carrying the phone.

---

## 10. External integrations — **NONE, deliberately**

Nothing is integrated. No bank, no Telebirr, no WhatsApp, no SMS, no email, no accounting system.

**This must be said plainly to the distributor**, because the screens could be misread:

| Looks like | Actually is |
|---|---|
| Payment evidence extraction | Reads a photograph into a *suggestion*. Nothing contacts a bank. **Finance's eyes are the verification** |
| AI inquiry parsing | Reads a message into a draft a person reviews. Cannot set a price or a status |
| AI daily brief | Turns already-calculated figures into sentences. Sees no customer names. A summary containing a figure the system did not calculate is discarded |
| Delivery "delivered" | *Marked completed by staff.* No signature, no photo, no proof of delivery |

With `AI_PROVIDER=disabled`, nothing leaves the building at all and the product says so.

---

## 11. Blockers before real data

1. **Deploy and run the deployment runbook end to end** against a real host. Nothing above has
   been executed against production.
2. **Implement the S3 storage adapter.** Production refuses local storage, correctly, so payment
   evidence cannot be stored until this exists.
3. **Restore drill against production**, once there is a production.
4. **Wire backup scheduling and failure alerting** to somewhere a person reads.

Items 1 and 2 are engineering. Items 3 and 4 are the ones most likely to be postponed and least
forgivable to have skipped.

---

## 12. The honest summary

The application is genuinely good: money is exact, tenancy is enforced three ways and proven on a
fresh database, the AI cannot invent a price or a payment, every consequential mutation is audited
and most are immutable, and the backup restores — verified, not asserted.

What it is not is *deployed*. Phase 9 made this system deployable and left it undeployed, and the
four blockers above are the distance between those two words.

**Recommendation:** do not put a real distributor's data in until items 1–4 are done. Then run one
distributor in parallel with their existing process for a week — not because failure is expected,
but because the failure that matters is a wrong number nobody notices, and it is only visible
against a second source of truth.
