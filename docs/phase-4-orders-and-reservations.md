# Phase 4 — Follow-ups, Orders and Stock Reservations

**Status:** complete. A sent quotation enters a deterministic follow-up queue; staff record what
the customer said; an accepted quotation becomes a sales order carrying its snapshots exactly;
and stock is reserved atomically or not at all.

**Not in this phase:** payment verification, warehouse execution, delivery, stock consumption,
external messaging, backorders, partial fulfilment, quote revision.

---

## 1. Follow-up model

`quotation_follow_ups` — a row per chase, not a counter on the quotation. "How many times did we
chase this and what did they say" is the question that makes a queue worth having, and a counter
cannot answer it.

| Field | Meaning |
|---|---|
| `sequence` | 1 for the first chase, 2 for the next; capped by `maxFollowUpCount` |
| `due_at` | when it falls due |
| `status` | `DUE` / `SNOOZED` / `COMPLETED` / `CANCELLED` |
| `outcome` | what happened, on completion |

`COMPLETED` and `CANCELLED` are terminal. A second attempt is a second row; reopening one would
lose the history the table exists to keep.

### Due rules

The first follow-up is created **inside the same transaction as `markSent`**, so a quotation
cannot be recorded as sent without appearing in the queue — precisely the failure the queue
exists to prevent. It falls due at `sentAt + followUpIntervalDays`.

Later chases are spaced from the **send**, not from the previous completion, so a salesperson
who chases late does not push every subsequent chase later with them.

The queue is a **query**, not a scheduler: open status, quotation still `SENT`, `due_at` passed.
No cron, no worker, nothing to fall over overnight.

### No autonomous recurrence

Scheduling the next chase requires an **explicit choice** (`scheduleNext`) *and* falls under
`maxFollowUpCount` (default 4). Both, not either: a queue that refills itself teaches people to
ignore it, which costs more than the chases are worth.

### No autonomous messaging

Nothing in this module sends anything, and nothing in it calls a model. AI follow-up drafting
was optional in the brief and is **deliberately not built** — the queue is the part of the
workflow a distributor cannot afford to have degrade when a provider is unreachable, and
reservation correctness was the better use of the phase.

---

## 2. Acceptance and rejection

`SENT → ACCEPTED` requires **all** of:

- the tenant matches
- status is `SENT`
- the approval is **live** — `currentPayloadHash === approvedPayloadHash`, re-derived inside the
  row lock rather than trusted from an earlier read
- the quotation has not passed its `validityDate`
- the actor holds `record:quotation-acceptance`

`DRAFT`, `PENDING_APPROVAL` and approved-but-unsent all refuse. Recording captures
`accepted_at`, `accepted_by`, `acceptance_source` (`PHONE`/`MESSAGE`/`EMAIL`/`IN_PERSON`/`OTHER`)
and an optional note.

**This is not an electronic signature.** Nothing authenticates the customer. The audit entry
carries `basis: "recorded_by_staff"` and the UI says so, because presenting it as more than it
is would be an overclaim that matters exactly when someone disputes the order.

`SENT → REJECTED` takes an **optional** reason category. Optional on purpose: forcing a category
produces a category, not a reason.

Both close every open follow-up in the same transaction.

### Two invariants about the validity date

They are separate and both hold:

1. An **expired** quotation cannot be accepted.
2. Editing the validity date **after approval invalidates the approval** — the date is in the
   approval payload.

The expiry test sets the date *before* approval so the approval covers that payload; otherwise
it would silently assert invalidation instead. Both are pinned by their own test.

---

## 3. Order state model

Three orthogonal fields rather than one conflated status, because whether money arrived and
whether goods may leave are different questions with different owners:

| Field | Values |
|---|---|
| `status` | `OPEN` · `CANCELLED` · `COMPLETED` (unreached in Phase 4) |
| `payment_status` | `UNPAID` · `NOT_REQUIRED_YET` · `PAID` |
| `fulfillment_status` | `NOT_READY` · `READY` · `CANCELLED` |

Initial position, from the accepted terms:

| Terms | Payment | Fulfilment |
|---|---|---|
| **Cash** | `UNPAID` | `NOT_READY` |
| **Credit** | `NOT_REQUIRED_YET` | `READY` |

**A cash order is never `READY` at creation.** Reserving stock must not imply the warehouse may
release goods; that unlock is Phase 5's, once finance confirms a payment. A credit customer has
already been granted terms, so nothing is owed yet and preparation may begin.

Neither creates a warehouse task. That is Phase 6, and the UI says so.

---

## 4. Order creation invariant

The **only** source of commercial values is the accepted quotation's snapshots — copied field
for field. Never the live catalogue price, never the current VAT rate, never a re-run of the
discount policy, never a model. A test asserts the order's grand total equals the quotation's to
the santim, and another moves the catalogue price, name and tax rate before converting and
asserts the order still carries the agreed figures.

### One order per quotation

Enforced at the database by a **partial unique index**:

```sql
CREATE UNIQUE INDEX sales_orders_one_active_per_quotation
  ON sales_orders (quotation_id) WHERE status <> 'CANCELLED';
```

Partial, so a cancelled order does not permanently block re-conversion after a mistake. The
application also checks first and returns the existing order on a repeat — but a check followed
by an insert is two operations, and a double-clicked button slips between them. The index is
what actually holds, and a concurrent-conversion test proves it.

---

## 5. Stock reservation

### The invariant

Phase 1's meaning is preserved unchanged:

```
available_stock   on hand, physically in the yard
reserved_stock    committed to open sales orders
free to reserve   available_stock − reserved_stock
```

A reservation raises `reserved_stock`; it never touches `available_stock`. Goods do not leave the
yard when an order is raised, and pretending otherwise would make the system disagree with what
the warehouse counts.

### Source of truth

**`stock_reservations` rows are authoritative.** `product.reserved_stock` is a maintained
aggregate of the `ACTIVE` rows, written in the same transaction.

Keeping the rows is what makes a release exact: cancellation subtracts precisely what *that
order* took, rather than decrementing a shared counter by a number somebody recomputed. That is
how aggregates drift and how "why does this product show 40 reserved with no open orders" becomes
unanswerable.

Every integration test that touches stock asserts
`reserved_stock == Σ ACTIVE reservations` afterwards, and a database `CHECK` backstops
`reserved_stock <= available_stock`.

### Insufficient stock

**All or nothing.** If any line is short, nothing is reserved — not the lines that would have
fitted, not a reduced quantity, not a backorder, not a substitute. Partial reservation looks
helpful and is not: it leaves an order that is neither fulfillable nor refused, and the
salesperson finds out at the warehouse door.

The refusal is structured — `INSUFFICIENT_STOCK` carrying requested / available / shortfall per
product — because those numbers are what the salesperson needs for the next conversation.

Quantities are summed **per product** before checking, so a quotation naming cement on two lines
cannot reserve twice what exists.

### Acceptance ≠ availability

A quotation being accepted does not guarantee the stock still exists. Between sending and
hearing back, the yard changes. So reservation happens at conversion and can fail there, and a
failure leaves the accepted quotation **completely untouched** — it is the record of what the
customer agreed to, and rewriting it to fit the yard would destroy that.

---

## 6. Transaction boundaries and lock ordering

Order creation is one transaction:

1. lock the product rows, **ascending by product id**
2. load the accepted quotation
3. refuse if an active order already exists
4. check the acceptance invariants
5. plan the reservation; refuse in full if any line is short
6. create the order, its items and the reservation rows
7. raise the aggregate on each product
8. audit
9. commit

Products are locked **before** the quotation is read, so availability cannot move between being
checked and being committed against.

### Why ascending id, one statement at a time

Two orders sharing cement and rebar would otherwise take the two locks in opposite orders and
deadlock — intermittently, under load, which is the worst kind to diagnose. `lockOrder()`
de-duplicates and sorts; the locks are then taken with one `SELECT … FOR UPDATE` per id in that
sequence. A single `ORDER BY … FOR UPDATE` would usually lock in the same order, but "usually" is
not a property to rest a deadlock guarantee on.

Cancellation uses the same ordering, so a cancellation racing a conversion over shared products
cannot deadlock with it.

---

## 7. Cancellation and release

An authorised actor cancels an `OPEN` order. In one transaction: lock the order, lock the
affected products in the same deterministic order, mark each `ACTIVE` reservation `RELEASED`
with a timestamp, subtract exactly those quantities from the aggregate, zero the line
`reserved_quantity`, set the order `CANCELLED`, audit.

**Idempotent.** A second cancellation returns `alreadyCancelled: true` and releases nothing —
the reservations are already `RELEASED`, and re-running the release would subtract stock that was
never held. A concurrent double-cancel test pins this.

Reservations are **marked**, never deleted: `DELETE` is revoked from the application role, so the
evidence of what an order committed survives.

**The quotation is left alone.** It remains the record of what the customer accepted; cancelling
an order does not unmake that.

---

## 8. RBAC

New: `read:follow-up`, `complete:follow-up`, `record:quotation-acceptance`,
`record:quotation-rejection`, `create:sales-order`.

Reused rather than duplicated: `read:order` and `cancel:order` were declared in Phase 1 and never
checked. Coining `read:sales-order` beside an existing `read:order` would have been two names for
one concept.

| Role | Follow-ups | Accept / reject | Create order | Cancel order | Read order |
|---|---|---|---|---|---|
| Owner / Admin | yes | yes | yes | yes | yes |
| Sales Manager | yes | yes | yes | **yes** | yes |
| Salesperson | yes | yes | yes | **no** | yes |
| Finance | no | no | no | no | yes |
| Warehouse | no | no | no | no | yes |

A salesperson raises orders but does not cancel them: cancellation releases reserved stock and
unwinds a commitment, which is a manager's call. Finance and warehouse read orders and cannot
reserve or release anything.

---

## 9. Audit

`followup.created`, `followup.completed`, `followup.snoozed`, `followup.cancelled`,
`quotation.accepted`, `quotation.rejected`, `order.created`, `order.stock_reserved`,
`order.cancelled`, `order.stock_released`, and
`order.creation_refused_insufficient_stock`.

That last one is deliberate: a conversion that fails for stock is a sale already won and then
lost to inventory, which is a different problem from a quotation that was never accepted, and a
distributor will want to count it.

All transaction-bound, per Phase 1. A rollback test proves a cancellation that does not commit
leaves neither the release nor its audit row.

---

## 10. Metrics

Derivable from the operational tables: open and overdue follow-ups, completion rate, average
days to complete, outcome distribution, sent/accepted/rejected counts, acceptance and rejection
rates, rejection reasons, average days to accept, orders created and cancelled, accepted
quotations with no order, stock refusals, and reserved stock by product.

---

## 11. Known limitations

1. **No AI follow-up drafting.** Optional in the brief; skipped deliberately (§1).
2. **No partial fulfilment, backorder or substitution.** All-or-nothing reservation is the MVP
   policy; a short conversion is refused and a person decides what to do.
3. **No quote revision workflow.** If a customer agrees to different quantities after acceptance,
   the honest answer is a new quotation, and that flow does not exist yet.
4. **`COMPLETED` is unreachable.** Orders stay `OPEN` until cancelled; completion belongs with
   fulfilment.
5. **No stock consumption.** Reservations never reach `CONSUMED`; goods leaving the yard is Phase 6.
6. **No expiry sweep.** Quotations past their validity date refuse acceptance but are not marked
   `EXPIRED` by anything.
7. **Follow-up assignment is simplistic** — the sender, and no reassignment UI.
8. **The queue has no paging.** Capped at 200 rows, which is fine at pilot volume.
9. **Snooze moves `due_at` from now**, not from the original due date, so repeated snoozing
   drifts the schedule. Acceptable, and worth revisiting if it is used heavily.

---

## 12. What Phase 5 depends on

- **A cash order is `UNPAID` + `NOT_READY`.** Payment confirmation is what should move it to
  `PAID` and unlock `READY`. Nothing else may.
- **Reservations already exist and are owned per order.** Fulfilment should move them
  `ACTIVE → CONSUMED`, not decrement a counter.
- **`payment_due_date`** is already computed for credit orders and is the basis for receivables.
- **The approval-binding pattern generalises.** Payment confirmation is the same shape — a person
  putting their name to specific figures — and should reuse `buildApprovalPayload`/`hashPayload`
  rather than inventing a second mechanism.
