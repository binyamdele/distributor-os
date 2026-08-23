# Data Retention and Privacy

What personal and business data this system holds, who can reach it, and how long it is kept.

**Retention is documented, not automated.** Nothing here deletes anything on a schedule, and that
is deliberate: deleting a distributor's business records is irreversible, and the right retention
window is a decision for them and their accountant, not a default this repository picks.

---

## 1. What is stored

### About the distributor's customers

| Data | Where | Why |
|---|---|---|
| Company name, contact name | `customers` | Identifying who a quotation is for |
| Phone, email, address | `customers` | Contacting them; delivery destination |
| Credit status, limit, terms | `customers` | Whether credit may be offered |
| Enquiry text, verbatim | `inquiries` | What they asked for. **Can contain anything they typed** |
| Quotations, orders, prices, discounts | `quotations`, `sales_orders` | The commercial record |
| Payment claims and evidence | `payments`, `payment_evidence_files` | Bank slips and transfer screenshots — **the most sensitive data here** |
| Delivery snapshots | `deliveries` | Name, phone, destination at the time goods went out |

### About the distributor's staff

| Data | Where |
|---|---|
| Name, email, role | `users`, `memberships` |
| Password | `users.password_hash` — scrypt, never reversible |
| Sessions | `sessions` — token **hash**, never the token |
| Every consequential action | `audit_events` — who did what, when, with before and after |

The audit log is the one worth calling out: it is a per-person record of activity. That is exactly
what makes it valuable when a payment is disputed, and exactly what makes it personal data. It is
readable only by roles holding `read:audit` — owner, sales manager, finance.

---

## 2. Payment evidence

The most sensitive category, and the one with the strongest controls:

- stored **outside the database and outside the web root**, under keys the store invents
- the `FileStore` interface has **no URL method**, so no public or signed link can be produced by
  accident
- the only read path checks session, then `read:payment`, then tenant — a foreign id, a malformed
  id and a nonexistent id all return the same 404
- a SHA-256 is recorded, so tampering is detectable
- **never logged, never sent to an error reporter, never included in AI prompts**

Sales can attach a bank slip and cannot read one back. Warehouse cannot see them at all.

---

## 3. Who can reach what

| | Customer contacts | Prices | Payment evidence | Receivables | Audit |
|---|---|---|---|---|---|
| Owner | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sales Manager | ✓ | ✓ | — | ✓ | ✓ |
| Salesperson | ✓ | ✓ | submit only | — | — |
| Finance | ✓ | read | ✓ | ✓ | ✓ |
| Warehouse | — | — | — | — | — |

Access follows roles, enforced server-side on every request. The warehouse row is deliberately
empty across the board: a picker needs a SKU, a unit and a quantity.

---

## 4. Retention classes

| Class | Contents | Suggested | Why it is not automated |
|---|---|---|---|
| **Business records** | customers, quotations, orders, payments, stock | Indefinite, or per local statutory requirement | Ethiopian tax and company law set minimums; deleting early could be unlawful. A decision for the distributor's accountant |
| **Audit history** | `audit_events` | ≥ 7 years | It exists to answer questions years later. Trimming it defeats the purpose |
| **Payment evidence** | bank slips | With the payment it proves | Deleting evidence while keeping the payment record leaves an unprovable claim |
| **Application logs** | structured logs | 30–90 days | Long enough for support, short enough to limit exposure. Set where logs are shipped |
| **Backups** | database dumps | 7 daily, 4 weekly, 6 monthly | See the backup runbook |
| **Sessions** | `sessions` | Expire automatically | Already handled; expired rows can be pruned |

**Nothing deletes business data automatically, and nothing should be added that does** without an
explicit decision recorded here.

---

## 5. What leaves the building

**Almost nothing, by design.**

| Destination | What goes | When |
|---|---|---|
| AI provider (inquiry parsing) | the customer's message text | Only when `AI_PROVIDER=anthropic`. **Contains whatever the customer wrote** |
| AI provider (payment extraction) | the evidence image bytes | Only when extraction is run |
| AI provider (daily brief) | counts and pre-formatted amounts — **no names, no order numbers, no message text** | Only when narration is enabled |
| Error reporter | error message, stack, correlation id, organization and actor ids — **redacted** | On unhandled exceptions, if a DSN is set |

Three things follow, and they are worth saying to a distributor plainly:

1. **No analytics.** No Google Analytics, no product telemetry, no third-party scripts. Nothing
   about a user's behaviour is exported anywhere.
2. **The daily brief cannot leak a customer.** It receives counts and amounts only — the dashboard
   renders the largest order's customer name itself, and that name never enters a prompt.
3. **Setting `AI_PROVIDER=disabled` means nothing leaves at all.** The manual inquiry path and the
   deterministic brief both work, and the product tells the truth about what it is doing.

---

## 6. Rights and requests

Ethiopia has no comprehensive data-protection statute equivalent to GDPR, and this product is not
built to satisfy one. What exists today:

| Request | Possible? | How |
|---|---|---|
| "What do you hold about me?" | Yes, manually | Query by customer id across the business tables |
| "Correct it" | Yes | Edit the customer record. Historical quotations keep their snapshots, deliberately — a quotation is what was agreed |
| "Delete me" | **Partially, and not silently** | Contact details can be cleared. Commercial records cannot be deleted without destroying the audit trail and the accounting history |

**If the pilot ever needs genuine erasure**, the design decision is anonymisation rather than
deletion: replace identifying fields, keep the commercial record. That has not been built, and
building it speculatively would be guessing at a requirement nobody has stated.

---

## 7. Breach response

1. Rotate every credential — session secret, database password, object-store keys, API keys.
   Rotating the session secret signs everybody out, which is the point.
2. Determine scope from the audit log and application logs.
3. Preserve evidence: take a backup **before** changing anything.
4. Tell the distributor. It is their customers' data.
5. Record it in [`pilot-issue-template.md`](pilot-issue-template.md) with full detail.

---

## 8. Honest limits

- **No automated retention or erasure.** Documented above and deliberately unbuilt.
- **No field-level encryption.** Data is encrypted in transit (TLS) and at rest (the managed
  database's disk encryption). Individual columns are not separately encrypted, so anyone with
  database access sees everything — which is why the two-role setup and RLS matter.
- **Backups contain everything**, including payment evidence references. They must be encrypted
  and access-controlled at least as tightly as the database.
- **No consent management.** The distributor's relationship with their customers is theirs.
