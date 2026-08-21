# Phase 3 — Quotations

**Status:** complete. A reviewed `READY_FOR_QUOTE` inquiry becomes a priced, snapshotted
quotation; discounts and delivery charges are applied deterministically; approval authority is
decided by rules and bound to the exact figures; and an approved quotation can be marked sent.

**Not in this phase:** sales orders, stock reservation, payments, external sending, PDF.

---

## 1. Domain model

| Table | Purpose |
|---|---|
| `quotations` | Header: number, customer, status, terms, totals, approval binding |
| `quotation_items` | One priced line, with every commercial fact snapshotted |
| `quotation_approvals` | Append-only record of who decided what, on which exact payload |

Plus one column on `organization_settings`: `delivery_fee_taxable`.

All three tables carry `organization_id`, have RLS policies with the same NULLIF-guarded
predicate as every other business table, and `quotation_approvals` has `UPDATE`/`DELETE` revoked
from the application role. Two `CHECK` constraints refuse negative totals and insane line values
at the database, so a calculation bug stops rather than reaching a customer.

---

## 2. State machine

```
DRAFT ──▶ PENDING_APPROVAL ──▶ APPROVED ──▶ SENT ──▶ ACCEPTED (Phase 4)
  ▲            │                   │                    │
  └────────────┴───────────────────┘                    ▼
       an approval-sensitive edit             REJECTED / EXPIRED / SUPERSEDED
```

Also `CANCELLED` from `DRAFT`, `PENDING_APPROVAL` and `APPROVED`.

Three edges are worth stating:

- **`APPROVED → DRAFT`, not `→ PENDING_APPROVAL`.** An edit withdraws the approval and returns
  the quotation to draft. Re-queueing an approval request the salesperson never made would be
  making a request in their name; they resubmit deliberately or not at all.
- **`SENT` has no path back to `DRAFT`.** Once the customer has the figures, the honest move is
  a new version marking the old one `SUPERSEDED`, not a quiet edit of what they were sent.
- **`ACCEPTED` exists but is unreachable in Phase 3.** It is in the enum and the transition
  table so Phase 4 needs no migration; no action and no UI drives it.

---

## 3. Snapshot semantics

Every commercial fact a customer is shown lives in a `_snapshot` column on the line: SKU,
description, unit, list price, tax rate. `product_id` is retained for traceability — "which
catalogue entry did this come from" is a real question — but **nothing is ever read back through
it** to render the quotation.

Consequences, all tested:

- Repricing OPC Cement from ETB 1,250 to ETB 1,510 leaves an existing quotation's figures and
  its grand total untouched.
- Renaming the product leaves the line description unchanged.
- Deleting the product leaves the line intact; only the live stock context disappears.

The live catalogue price and stock **are** displayed beside the snapshot, flagged when the price
has moved, so a salesperson can see that the world has changed without the quotation changing
underneath them.

---

## 4. Money: the exact calculation order

Per line, in this sequence:

```
gross     = quantity × quotedUnitPrice          exact, no rounding
discount  = half-up(gross × discountBp / 10000)
taxable   = gross − discount
tax       = half-up(taxable × taxRateBp / 10000)
lineTotal = taxable + tax
```

Then across lines:

```
subtotal      = Σ gross
discountTotal = Σ discount
deliveryTax   = half-up(deliveryFee × vatRateBp / 10000)   when taxable, else 0
taxTotal      = Σ tax + deliveryTax
grandTotal    = Σ lineTotal + deliveryFee + deliveryTax
```

The identity `grandTotal = subtotal − discountTotal + taxTotal + deliveryFee` holds exactly.
`reconciles()` asserts it, and `recalculate()` **throws** rather than persisting a quotation
whose parts do not add up to its whole.

**Why round per line and then sum.** Summing exact values and rounding once is marginally more
accurate and far less defensible: the printed line totals would not add up to the printed grand
total, and the first customer to check would be right to query it.

**Why the discount applies to the line, not the unit price.** Discounting the unit first and
multiplying second loses up to half a santim per unit — on 15,000 blocks that is real money —
and produces a per-unit price that does not divide the line total. The effective unit price is
computed for display only, and a test asserts it may not multiply back exactly, which is
precisely why the line total is the authoritative figure.

**Delivery tax.** Stated, not assumed: `delivery_fee_taxable` defaults to `true`, because
transport supplied with goods is normally taxable, and an organization that believes otherwise
should say so on a settings screen rather than discover it in a total. The delivery tax is
stored in its own column so the document can show it and a policy change stays visible.

---

## 5. Quantities

**Integer units only.** `priceLine` throws on a fractional, zero or negative quantity, the
column is `Int`, and a `CHECK` constraint enforces `quantity > 0`. Every product in the target
catalogue is sold in whole bags, pieces, cubic metres or quintals. Introducing fractional
quantities would mean introducing a fractional representation, and a float would be the obvious
wrong choice; if a distributor ever sells by weight, the right answer is a scaled integer with
an explicit precision, not a `number`.

---

## 6. Discounts

Per-line basis points: `250` = 2.5%. Entered as a percentage in the UI and converted through
the money module's decimal parser, so `"2.5"` never becomes a float.

The UI shows list price, discount and resulting quoted price as three separate columns. There is
**no direct unit-price override** in Phase 3 — the brief prefers an explicit discount, and an
opaque edited price hides the size of the concession from the person approving it.
`quoted_unit_price_minor` exists and equals the list snapshot, so an authorised override can be
added later without a migration.

---

## 7. Approval rules

Read from `organization_settings`. Defaults in brackets.

| Rule | Condition | Outcome |
|---|---|---|
| A | deepest discount ≤ `salespersonDiscountLimitBp` (300) | `SALESPERSON` |
| B | ≤ `salesManagerDiscountLimitBp` (1000) | `SALES_MANAGER` |
| C | above the manager limit | **`BLOCKED`** |
| D | any line priced below `minimumPriceFloorBp` (9000) of its own list | **`BLOCKED`** |
| E | credit terms for a `SUSPENDED` customer | **`BLOCKED`** — a cash quotation is fine |
| F | credit terms for a `CASH_ONLY` customer | **`BLOCKED`** — a cash quotation is fine |
| — | credit days beyond the customer's agreed terms | **`BLOCKED`** |

There is no "no approval required" outcome. Every quotation needs a signature; the rules decide
*whose*.

**Rule C blocks rather than escalating.** Past the manager ceiling there is no bigger signature.
The organization has already said it does not want that discount made line by line, and the
remedy is to change the number — or to raise the configured limit, which is a deliberate,
audited act rather than a one-off override buried in a quotation.

**The ladder is driven by the deepest line, not an average.** A quotation with one line at 40%
and nine at zero has given away 40% on something; averaging would hide it.

**Rule D is checked independently of the ladder.** The two coincide at 10% under the defaults,
but an organization can set a 5% floor with a 10% manager limit, and then a 7% discount is
inside the ladder and through the floor at once. The floor is measured per line against that
line's own list price, so a deep cut on one product cannot hide behind full-price volume on
another. The comparison is cross-multiplied in integers — no division, so no rounding can move a
breach to a pass.

**Rules E and F are deliberately narrow.** A suspended customer is not one you cannot sell to;
it is one you cannot lend to. Blocking the whole quotation would be a misreading that costs a
distributor real business.

---

## 8. Payment terms

`CASH`, or `CREDIT` at 7, 15 or 30 days. Credit requires `CREDIT_ALLOWED` and may not exceed the
days that customer has actually been granted. The UI withholds credit options entirely for an
ineligible customer rather than offering an option the rules will refuse. Changing the customer
on a draft **drops** credit terms the new customer is not entitled to rather than carrying them
across — quietly keeping them would be the system extending credit nobody authorised.

No credit scoring, no AI, no automatic limit changes.

---

## 9. The approval payload fingerprint

Hashed with the Phase 1 `hashPayload` — the type-tagging one, which does not collide a bigint
with the string spelling of it. That property is load-bearing: every amount in the payload is a
bigint.

**In the payload:** `organizationId`, `quotationId`, `customerId`, the customer's credit status,
currency, payment type and terms, validity date (as a calendar date, so the machine's timezone
cannot enter the hash), and for every line — product id, SKU, description, unit, quantity, list
price, quoted price, discount, tax rate and all five computed line amounts — plus delivery fee,
delivery tax, subtotal, discount total, tax total and grand total.

The computed amounts are included even though they are derivable: a change to the rounding rule
or the delivery-tax policy would alter what the approver saw without altering a single input,
and an approval surviving that would be a lie.

**Out of the payload:** quotation number, timestamps, creator, and **notes**. Notes change what
the customer reads, not what the organization is committing to; treating a typo fix as grounds
for re-approval is how a control like this stops being taken seriously. A test asserts editing a
note does not revoke an approval.

Lines are sorted by `sortOrder` before hashing, so reordering that changes no commercial fact
does not revoke an approval.

`organizationId` is in the payload specifically so a hash cannot be valid across tenants — and a
test proves two organizations with identical figures produce different hashes.

---

## 10. Approval invalidation

`approved_payload_hash` is written at approval; `current_payload_hash` is recomputed from the
persisted rows after every mutation. **Approval is live only when status is `APPROVED` and the
two hashes agree.**

Every commercial edit goes through one envelope that always does four things together: takes the
row lock, applies the change, recomputes every derived figure and the hash, and — if the
quotation was approved or pending — withdraws that and returns it to `DRAFT`, clearing
`approved_by`, `approved_at` and `approved_payload_hash`. The `quotation_approvals` row survives,
so "who approved which version" stays answerable, and the UI marks it `superseded`.

Tested as withdrawn by: quantity, discount, delivery fee, payment terms, line removal, line
addition, and customer change. Tested as *not* withdrawn by: a note edit.

**`markSent` does not trust the status.** It re-derives the hash inside the lock and refuses on
mismatch. A test tampers with a line directly in the database, bypassing every application code
path, and the send is still refused — so the invariant does not depend on the edit path having
run.

---

## 11. Numbering

`Q-000001`, from the existing `number_sequences` table, allocated by a single atomic statement:

```sql
INSERT INTO number_sequences (...) VALUES (..., 2)
ON CONFLICT (organization_id, kind)
DO UPDATE SET next_value = number_sequences.next_value + 1
RETURNING next_value - 1
```

Read and write are one operation holding a row lock for their duration, so there is no window
between deciding a number and claiming it. `count(*) + 1` was rejected: it races, and it reuses
numbers after a deletion, so two documents can carry the same number months apart.

Gaps are possible — a transaction that allocates and then rolls back consumes a number. That is
the correct trade: a gap is a cosmetic oddity, a duplicate is a commercial dispute. Tested with
eight concurrent creations producing eight distinct numbers, and with each organization getting
its own `Q-000001`.

---

## 12. Concurrency

Every mutation and every decision begins with `SELECT … FOR UPDATE` on the quotation row, so an
edit and an approval arriving together are serialised by the database rather than by HTTP timing.

- **Approve vs edit.** If the edit lands first, the approval finds the status is `DRAFT` and
  refuses. If the approval lands first, the edit withdraws it. Either way the final state is
  coherent, and the test asserts that if an approval is live its hash matches the stored figures.
- **Double approval** is idempotent: approving the same figures twice records one decision.
- **Send vs edit.** Either the send happens against approved figures, or the quotation is back
  in draft. It cannot be `SENT` carrying figures nobody approved.
- **Approve with a stale screen.** The UI submits the hash it rendered; a mismatch is refused
  with `APPROVAL_PAYLOAD_MISMATCH` rather than silently approving something else.

---

## 13. Tenancy

Every identifier arriving from a client — product, customer, inquiry, quotation, line — is
re-resolved through the tenant-scoped client, so a foreign id is *not found* rather than
filtered. `tests/security/quotation-tenancy.test.ts` tests this with **planted foreign ids**,
not by navigating the UI: normal navigation cannot produce a foreign id, so a test that only
navigates proves nothing about the boundary.

The most valuable case is a real quotation in the right organization with a product id from the
wrong one — refused, not silently priced from the other catalogue.

---

## 14. Known limitations

1. **No PDF.** A quotation is viewed in the app. PDF generation was deferred as the brief allows;
   it is a dependency sink and the shareable view tests the same hypothesis.
2. **No customer-facing shareable link.** The quotation is visible to signed-in staff only.
3. **No unit-price override.** Only discounts. The column exists for a future authorised override.
4. **No supersede flow.** `SUPERSEDED` is in the state machine but nothing drives it; revising a
   sent quotation means creating a new one by hand from the inquiry.
5. **No expiry job.** `validityDate` is stored and displayed; nothing sweeps expired quotations.
   `EXPIRED` is reachable in the state machine but not driven.
6. **No AI wording.** The brief made customer-facing drafting optional in this phase, and nothing
   in the quotation path calls a model. Phase 3 is fully functional with `AI_PROVIDER=mock` or
   with the provider unavailable.
7. **Recalculation rewrites every line on every edit.** Fine at MVP line counts; a hundred-line
   quotation does a hundred small updates per edit.
8. **Notes are excluded from the hash by design** (§9). An organization that considers customer
   notes commercially binding would need them added.

---

## 15. Decisions later phases depend on

- **Phase 4 must read `SENT`/`ACCEPTED` quotations and their snapshots**, never the live
  catalogue. The snapshot is the commercial truth of what was promised.
- **Stock is still not reserved.** Asserted by a test in this phase. Reservation belongs to the
  sales order in Phase 4, per `architecture-baseline.md` §7.3.
- **`ACCEPTED` is the entry point for order conversion** and already exists in the enum and the
  transition table.
- **`quotation_approvals` is append-only.** Phase 4 must not rewrite it to record an order.
- **The approval-binding pattern generalises.** Payment confirmation in Phase 5 has the same
  shape — a person putting their name to specific figures — and should reuse
  `buildApprovalPayload`/`hashPayload` rather than inventing a second mechanism.
