# Phase 6 — Warehouse Fulfilment and Delivery

**Status:** complete. An order that has cleared its payment gate can be sent to the warehouse,
picked, and handed over — and handing it over is the single operation in the product that
removes physical stock. Goods then either go out on a delivery or are collected, and the order
is completed operationally without that saying anything about whether it has been paid.

**Not in this phase:** partial fulfilment, split shipment, backorders, substitutions, returns,
refunds, failed-delivery restocking, route optimisation, maps, geocoding, ETAs, driver accounts,
a driver app, live GPS, a vehicle fleet database, proof-of-delivery signatures or photographs,
barcode scanning, bin locations, warehouse zones, picking optimisation, procurement, supplier
management, an accounting ledger, and any customer notification of any kind.

---

## 1. Three axes, three owners

An order now carries four status values where a simpler product would have one:

| Axis | Question it answers | Who decides |
|---|---|---|
| `salesOrder.status` | is this order live, cancelled, or finished | the workflow |
| `salesOrder.paymentStatus` | has the money arrived | Finance |
| `warehouseTask.status` | have the goods been picked and handed over | the warehouse |
| `delivery.status` | did they reach the customer | whoever drove |

They are separate because reality does not put them in one order. A credit order can be
delivered and unpaid. A paid order can sit unpicked for a week. A delivery can fail while both
the money and the picking were fine. Collapsing any pair forces a total ordering that does not
exist, and the cost is not abstract: it is a warehouse releasing goods because somebody needed a
value for "done".

`salesOrder.fulfillmentStatus` (Phase 4) is unchanged and still means "may this order be
prepared at all" — the gate, not the progress.

---

## 2. Stock semantics — confirmed, not reinterpreted

Phase 1 defined these and Phase 4 restated them in
[`reservation.ts`](../src/modules/orders/reservation.ts). Phase 6 changes nothing:

```
availableStock   on hand, physically in the yard
reservedStock    the portion committed to open sales orders
free             availableStock − reservedStock, what may still be promised
```

Raising an order moves nothing physical: it raises `reservedStock` only, because the bags are
still on the floor. Fulfilment is the opposite moment, so consumption decrements **both**:

```
before   available 100   reserved 30    free 70
ship 30
after    available  70   reserved  0    free 70
```

`free` is unchanged, which is the point — those 30 bags were never promisable to anyone else, so
their becoming physically absent changes nothing about what can still be sold. Decrementing only
`availableStock` would destroy 30 units of sellable stock; decrementing only `reservedStock`
would offer goods that are on a lorry.

The reservation row moves `ACTIVE → CONSUMED` and stays as the historical trace.

---

## 3. The warehouse task state machine

```
PENDING ──► IN_PROGRESS ──► PREPARED ──► COMPLETED
   │             │              │
   └─────────────┴──────────────┴──► CANCELLED
```

`COMPLETED` is terminal, and terminal for a physical reason: there is no operation that
un-ships something. `CANCELLED` is reachable right up to that point, because picked goods are
still on the premises and putting them back is a walk to the shelf.

Cancelling a task does **not** release the order's reservations. The order still exists and
still owns what was committed to it; cancelling the picking job is not cancelling the
commitment.

### Task creation

Allowed only when the order is operationally eligible, read from stored columns via
`assessEligibility`:

- `status = OPEN`
- `fulfillmentStatus = READY`
- for a cash order, `paymentStatus = PAID`
- at least one line holding stock

`fulfillmentStatus = READY` is the load-bearing check. On a cash order that value can only have
been written by a Phase 5 confirmation that settled the balance in full; on a credit order it
was written at conversion. **No payment arithmetic happens in the warehouse module** — a second
implementation of the payment rule is how the two drift apart, and the day they disagree is the
day goods go out against money that never arrived. The cash `PAID` check is redundant by
construction and is there anyway, because a redundant read of a stored column costs nothing and
would catch the one bug that matters.

Creation is idempotent, and a partial unique index
(`warehouse_tasks_one_active_per_order`) holds when two requests both check before either
writes.

### What the warehouse sees

Order number, customer, SKU snapshot, description snapshot, unit, quantity, the live reservation
figure, and on-hand. **No line prices, no order total, no payment evidence.** The one
money-adjacent field is a boolean — this order cleared its gate — because that is what makes it
pickable and it is all the yard needs to know.

Task items carry the snapshots forward one more time, so nothing the warehouse reads can be
changed by editing the catalogue afterwards.

---

## 4. Consumption: boundary, transaction, refusal

### The boundary is `PREPARED → COMPLETED`

Picking assembles goods that are still on the premises and still counted; a task that is picked
and then cancelled costs a walk back to the shelf and no correction. Completion is the moment
custody changes, which is the moment the physical count actually changes. Consuming at
`PREPARED` would show stock leaving while it is demonstrably still in the yard, and every stock
count would disagree with the system for as long as the goods sat by the door.

### The transaction

1. lock the order row, then the task row
2. lock every product this task touches, ascending by id, one statement each
3. re-derive the required quantities, the live reservations and the stock **inside** the locks
4. refuse on any mismatch, repairing nothing
5. decrement `available_stock` and `reserved_stock` together
6. move the reservations `ACTIVE → CONSUMED`
7. complete the task; create the delivery if the order needs one
8. complete the order if nothing else is outstanding
9. audit, with before and after figures per product

Step 3 is what makes it safe under concurrency: two completions against one task are serialised
by the task lock, and the second finds its reservations already `CONSUMED` rather than `ACTIVE`.

### Exact, not "at least"

`planConsumption` checks three things per product and requires the reservation to equal the
requirement **exactly**:

| Refusal | Meaning |
|---|---|
| `RESERVATION_MISSING` | nothing is reserved for a line that needs stock |
| `RESERVATION_SHORT` | less is reserved than must be handed over |
| `RESERVATION_EXCESS` | more is reserved than the order needs |
| `PHYSICAL_STOCK_SHORT` | the shelf cannot cover what is leaving |
| `AGGREGATE_DISAGREES` | `reserved_stock` disagrees with the ACTIVE rows |

"At least enough" is the tempting rule and the wrong one: consuming 30 out of a 45-unit
reservation would leave 15 committed to nothing, forever.

**Nothing is repaired.** A mismatch during fulfilment is an invariant violation, and the one
thing that must not happen is for a shipping operation to quietly adjust stock to make itself
succeed. A fulfilment that repairs its own preconditions can never be shown to have been
correct. Correcting a count is `adjustStock` in the catalogue module — a separate act, by a
person who has counted the shelf, with its own audit meaning — and Phase 6 deliberately leaves
the two unconnected.

The refusal names the product and both quantities, because the person reading it has to go and
count something.

### No partial fulfilment

There is no quantity parameter on "mark picked", by design: an API that accepts "8 of 12" is an
API that will eventually be used to ship 8 of 12. The database agrees — a task item is either
untouched or picked in full (`warehouse_task_items_all_or_nothing`), so a partial quantity is
unrepresentable.

---

## 5. Delivery

```
PENDING ──► ASSIGNED ──► DISPATCHED ──► DELIVERED
   │            │             │
   │            │             └────────► FAILED
   └────────────┴──► CANCELLED
```

Created by the warehouse handover, never before — which is what guarantees stock has actually
been consumed before anything goes on a lorry. Dispatch re-checks that the task is `COMPLETED`.

Assignment is three plain fields: driver name, driver phone, vehicle reference. There is no
driver account, no vehicle table and no fleet. A pilot distributor has three drivers and knows
their names.

### Snapshots

Customer name, phone and destination are copied at creation and never read live again. A
delivery record is history, and history that rewrites itself when someone edits a customer's
phone number is not history. The destination is the order's snapshotted delivery address as
plain text — not geocoded, not resolved, not validated against anything.

### Completion is not proof of delivery

`DELIVERED` records that a staff member said the goods arrived. There is no signature, no
photograph and no customer confirmation in this product, so the UI and the audit log both say
**"marked completed by staff"**. Calling it proof of delivery would be a claim the software
cannot support, and it is exactly the claim that gets read back when someone disputes it.

### A failed delivery restores nothing

`FAILED` is terminal and **no stock returns to inventory**. The goods left the yard and are
somewhere — on the lorry, at the wrong gate, refused at the door. Putting the quantity back
would invent inventory nobody has counted, at the precise moment the count matters. Offering a
retry would imply the system knows where the goods are. What the product can honestly do is
record the failure and let a person deal with it; a return is a separate physical event with its
own record, and it does not exist yet.

The audit event carries `stockRestored: false` explicitly, because the absence is the thing
someone will look for.

---

## 6. Collection

For an order with `deliveryRequired = false`, the warehouse records a collection: three fields
on the order (`pickedUpAt`, `pickedUpById`, `pickupNote`), not a `Delivery` row. Inventing a
delivery for a customer who drove to the yard would make the delivery queue claim there is a
vehicle on the road — the sort of small lie that makes an operational screen stop being trusted.

---

## 7. Order completion, and why it says nothing about money

An order reaches `COMPLETED` when:

- the warehouse task is `COMPLETED`, **and**
- for a cash order, `paymentStatus = PAID` (already true before the yard could start), **and**
- if delivery was required, the delivery is `DELIVERED`; otherwise a collection is recorded

**Completion is about goods, not money.** A delivered 30-day-credit order is `COMPLETED` and
owes every santim. It stays in receivables until Finance confirms a payment, and nothing on the
fulfilment path touches `paymentStatus`. Coupling completion to `PAID` for credit would erase a
debt by delivering it — the most expensive bug this phase could have contained.

The cash `PAID` re-check is not a re-run of the payment rule; it verifies that the state which
let the goods out is still the state on the row.

---

## 8. Cancellation

Three gates now, cumulative:

| Condition | Result |
|---|---|
| a confirmed payment exists (Phase 5) | blocked — record a refund instead |
| warehouse task `IN_PROGRESS` or `PREPARED` | blocked — cancel the task first, then the order |
| warehouse task `COMPLETED` | blocked permanently — the goods have gone |

A `PENDING` task does not block: nothing physical has happened, and cancelling releases the
reservations as it always did.

Nothing restores stock via cancellation after goods leave. That is a return, and it is a later
phase.

---

## 9. Lock ordering

Phases 4 and 5 established two partial orders — `payment → sales_order` for confirmation, and
`sales_order → products (ascending id)` for reservation and cancellation. Phase 6 extends them
into one total order rather than inventing a second convention:

```
payment → sales_order → warehouse_task → delivery → products (ascending id)
```

Every operation takes the prefix it needs and skips the rest, always left to right. This is a
strict superset of what already existed, so **no lock graph from an earlier phase changes**, and
two operations from different phases racing over the same order cannot take a pair of locks in
opposite directions.

Products are locked one statement per id in sorted order — the Phase 4 rule, unchanged. A single
`ORDER BY … FOR UPDATE` would usually lock in the same sequence, and "usually" is not a property
to rest a deadlock guarantee on.

No retries, no sleeps.

---

## 10. Database-level backstops

- `warehouse_tasks_one_active_per_order` — partial unique index; a cancelled task does not block
  a replacement.
- `deliveries_one_active_per_order` — the same, excluding cancelled and failed.
- `warehouse_tasks_timestamps_match_status` — a `COMPLETED` task without a `completed_at` is one
  nobody can place in time, and the metrics would silently compute from nulls.
- `warehouse_task_items_all_or_nothing` — a partial picked quantity is unrepresentable.
- `deliveries_timestamps_match_status` — `FAILED` needs a `failed_at`; nothing is both delivered
  and failed.
- `deliveries_has_destination` — a run nobody can make is not a delivery.
- `products_available_stock_non_negative` — narrow on purpose. Phase 4 already enforces
  `reserved_stock >= 0 AND reserved_stock <= available_stock`; Phase 6 adds the first operation
  that decrements `available_stock`, which can drive it below zero while that relationship still
  holds.
- Trigger `stock_reservations_consumed_immutable` — a `CONSUMED` reservation cannot be updated
  or deleted. It is the only record that specific goods left against a specific order.
- RLS on all three new tables, forced, with the Phase 1 `nullif(current_setting(...), '')`
  predicate.

---

## 11. RBAC

| Permission | Warehouse | Sales | Sales Manager | Finance |
|---|---|---|---|---|
| `read:warehouse-task`, `read:delivery` | ✓ | ✓ | ✓ | ✓ |
| `create:warehouse-task`, `start:`, `prepare:`, `complete:`, `cancel:` | ✓ | | | |
| `record:pickup` | ✓ | | | |
| `assign:delivery`, `dispatch:`, `complete:`, `fail:` | | | ✓ | |

Two separations are load-bearing:

- **Handing goods out is not picking them.** `complete:warehouse-task` is the permission that
  consumes stock; picking is reversible and that is not. Distinct permissions, so a future
  picker role can hold one without the other even though a small yard grants both today.
- **The warehouse cannot close an order end to end.** It hands goods out; declaring them
  delivered is someone else's signature. There is no dedicated logistics role in this product,
  so the four delivery permissions sit with the sales manager and the owner — the narrowest
  existing fit — rather than being used to justify inventing one.

Sales and Finance read fulfilment and mutate none of it: a salesperson answers "where is my
order", and whether goods went out changes what Finance says to a debtor.

The warehouse still holds `adjust:stock` and still does not hold `write:product`: it can say how
many bags are on the floor and cannot change what a bag costs.

---

## 12. Metrics

Derived per request, no stored counters and no scheduler: orders awaiting the warehouse, backlog
by status, mean hours to start / prepare / hand over, deliveries by status, failure rate and
reasons, mean hours on the road, consumed stock by product, and mean hours from task creation to
operational completion.

Consumed stock is derived from `CONSUMED` reservations rather than the audit log, because the
reservations are the operational record and the log describes it. They should agree; if they ever
do not, the reservations are what matches the floor.

---

## 13. Defects found and fixed in this phase

1. **A delivered credit order vanished from receivables.** `receivables()` filtered on
   `status: 'OPEN'`, which was correct while cancellation was the only way out of OPEN. Phase 6
   added a second exit, and a delivered credit order is precisely the debt a collections list
   exists to chase. Filtering it out would erase a receivable by delivering it. Now `OPEN` and
   `COMPLETED`; `CANCELLED` is still excluded.

2. **A paid cash order told the warehouse it could not act yet.** The order screen still carried
   "Warehouse preparation is not part of this phase", which stopped being true the moment this
   phase existed.

3. **The seed could create states the application refuses.** An early version of the Phase 6
   seed raised warehouse tasks — and completed handovers — against unpaid cash orders, because
   it never consulted the eligibility rule. A demo showing unpaid orders on a warehouse floor
   teaches the exact opposite of what this phase is for. The seed now imports the real
   `assessEligibility` and throws rather than writing such a task.

4. **The seed overwrote Phase 5's commercial terms.** Putting an order on credit terms rewrote
   `paymentDueDate` unconditionally, which erased the 24-days-overdue order the receivables demo
   is built on — the collections list went from having a top entry to having none. Phase 6 is a
   layer on top of those scenarios and has no business rewriting them.

5. **Re-seeding tripped the immutability trigger.** The Phase 5 seed deletes its scenario orders
   and their reservations, and a `CONSUMED` reservation refuses to be deleted — correctly. The
   fix was ordering, not weakening: Phase 6 unwinds first and puts the goods back, Phase 5
   rebuilds, Phase 6 walks them out again.

---

## 14. Evidence

- **679** unit tests, **372** integration and security tests against a real PostgreSQL 17,
  **128** Playwright specs across desktop and mobile (123 passed, 5 skipped by their own viewport
  guards). 1051 vitest tests in total.
- `pnpm typecheck`, `pnpm lint` and `next build` all clean.
- The migration chain was verified by replaying all 13 migrations against an empty database.

The six concurrency cases, each asserting an outcome that would be wrong under a naive
implementation:

| | Behaviour |
|---|---|
| A | Two handovers of one task → stock consumed once, one reservation transition, one audit event per product |
| B | Handover racing a cancellation → one coherent outcome; never consumed *and* released *and* cancelled |
| C | Two orders on the same product completing at once → decremented by the exact combined amount |
| D | Double-clicked dispatch → one transition, one audit event |
| E | Double-clicked delivery completion → one set of side effects, one `order.completed` |
| F | Two organizations fulfilling simultaneously → no interference, invariants hold in both |

---

## 15. Honest limits

- **No partial fulfilment, and that is a choice rather than an omission.** A yard that finds 10
  of 12 units gets a blocked completion naming both numbers. Resolving that exception is a
  workflow this product does not have.
- **A failed delivery leaves the order operationally unresolved and the stock consumed.** There
  is no return, no restock and no retry. That is the honest position: the goods are somewhere,
  and the software does not know where.
- **Nothing is sent to a customer.** The internal statuses would support "your order is out for
  delivery", and no message of any kind leaves the building in this phase.
- **Delivery addresses are plain text.** Not geocoded, not validated, not routed. A mapping
  phase can enrich `destination_text_snapshot` beside it without a migration of meaning.
- **Assignment is advisory.** Anyone with `dispatch:delivery` can dispatch an unassigned
  delivery; requiring a named driver first would be a field to fill in rather than a control.
- **All demo data is synthetic**, including driver names and vehicle plates.
