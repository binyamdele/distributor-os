# Phase 7 — Fulfilment Exceptions and Returns

**Status:** complete. The two ways Phase 6's fulfilment flow can go wrong now have governed
paths: a physical count that disagrees with the system, and a delivery that left the yard and
did not arrive. Neither path silently rewrites stock, neither rewrites what the customer agreed
to buy, and neither touches a confirmed payment.

**Not in this phase:** refunds, payment reversal, customer credit balances, replacement orders,
automatic reship after restock, accounting entries, a general ledger, an RMA portal, customer
self-service returns, return shipping labels, supplier returns, warranties, procurement,
batch/lot tracking, serial numbers, barcode scanning, warehouse locations, partial outbound
fulfilment, automatic substitution, AI stock correction, AI reservation prioritisation, route
optimisation, and live GPS.

---

## 1. The four truths, kept apart

| Truth | What holds it | What Phase 7 must never do |
|---|---|---|
| **Commercial** | the accepted order's quantities | rewrite them to make a warehouse problem disappear |
| **Inventory** | `product.available_stock` | change it without a movement row saying why |
| **Operational** | task, delivery, return, discrepancy records | erase an event by moving an earlier one backwards |
| **Financial** | confirmed payments | unconfirm, delete, or refund anything |

Every design decision below follows from keeping these four apart.

---

## 2. Exception taxonomy

**Pre-handoff** — the goods are still in the yard, and the shelf disagrees with the system. This
is an `InventoryDiscrepancy`. Nothing has shipped, so the remedy is a corrected count and,
sometimes, a decision about who does without.

**Post-handoff** — the goods have gone and the stock is already consumed. This is a failed
delivery, and the remedy is one of exactly three: send it again, bring it back, or write it off.

They are different problems and are never merged into one list, because the remedies have
nothing in common.

---

## 3. Inventory discrepancy lifecycle

```
OPEN ──► UNDER_REVIEW ──► RESOLVED
  │            │  ▲
  │            │  └── may be handed back to OPEN
  └────────────┴────► CANCELLED
```

`RESOLVED` is terminal — it records a decision somebody made about physical stock, and a
database trigger refuses to update or delete a resolved row. Reopening it in place would erase
which decision was made and when.

### Reporting is not correcting

`reportDiscrepancy` **changes no stock**. It records what the system claimed, what was committed,
what was counted, and the variance — all snapshotted, never re-read later. That snapshot is the
whole value of the record: it says what the system asserted *at the moment somebody disagreed
with it*, and re-deriving it afterwards would erase the disagreement.

The separation is also a control. If typing a number corrected inventory, one person could move
stock by filling in a box.

### It blocks the handoff

`completeWarehouseTask` locks its task's `OPEN`/`UNDER_REVIEW` discrepancies before locking
products, then refuses with the product name, both figures and the variance. The refusal is
server-side; the UI's route into the exception workflow is a convenience on top of it.

---

## 4. Reconciliation

`reconcileDiscrepancy` re-reads the live on-hand and the live ACTIVE reservation total **inside
the locks**, then refuses in four cases:

| Refusal | Why |
|---|---|
| `ALREADY_RESOLVED` / `CANCELLED` | a discrepancy resolves once; a trigger enforces it too |
| `STOCK_MOVED_SINCE_REPORT` | the count was taken against a figure that has since changed, so the delta would be from a stale baseline — the right answer is to count again |
| `RESERVATION_SHORTFALL` | see §5 |
| `NOTHING_TO_CHANGE` | the recount agreed; resolved as `COUNT_CONFIRMED_NO_CHANGE`, because the count happened and the record should say so |

On success it applies the delta, writes an `InventoryMovement`, and resolves the row — all in one
transaction.

---

## 5. Reservation-shortfall policy

The §11 case: on-hand 100, reserved 80, verified count 60. Persisting 60 would leave
`available_stock < reserved_stock` — which the Phase 4 CHECK refuses, and which would in any case
be a promise the yard cannot keep.

**The policy is the simplest safe one: reconciliation refuses to finalise.** It records
`reservation_shortfall` on the discrepancy, surfaces the affected orders, and stops.

Clearing it requires `resolve:reservation-shortfall` — held by a sales manager and the owner,
and deliberately **not** by the warehouse. Somebody is not getting their cement, and choosing who
is a conversation with a relationship behind it.

**No ranking is applied anywhere.** The affected orders are sorted by order number, which is to
say by nothing meaningful: not oldest first, not largest first, not by customer value, and not by
a model. A list that arrived pre-sorted by "priority" would be making the decision while
appearing merely to display information.

### The order is not rewritten

Reducing a reservation updates `sales_order_items.reserved_quantity` and leaves `quantity` — what
the customer agreed to buy — untouched. The order is left saying "80 required, 60 reserved" and
carries `operationalException = STOCK_SHORTFALL`, which is the honest description of where it
stands. No backorder, no substitute SKU, no split shipment, no revised quotation.

---

## 6. The inventory movement ledger

Phase 1's `stock_adjustments` **is** this table, renamed to `inventory_movements` and widened.
It already had the right shape — product, signed delta, resulting quantity, reason, actor,
timestamp — and the only thing wrong with it was scope: manual corrections landed there while
fulfilment consumption landed only in the audit log, so nothing could answer

> Why did Rebar 12mm decrease by 40?

The migration is a genuine `ALTER TABLE … RENAME`, so the 31 existing rows carried forward as
`MANUAL_ADJUSTMENT` rather than being orphaned beside a new table. Two competing stock-mutation
paths would have been worse than one that had to grow.

Every physical stock change now writes a movement: `MANUAL_ADJUSTMENT`,
`FULFILLMENT_CONSUMPTION` (Phase 6, added as history — its stock arithmetic is unchanged),
`DISCREPANCY_RECONCILIATION`, `RETURN_RESTOCK`.

It is **not** an accounting ledger and **not** event sourcing. `product.available_stock` remains
the authority; `reconcileLedger()` checks that the history is consistent with it from the oldest
movement's implied opening balance. `UPDATE` and `DELETE` are revoked from the application role:
a mistaken movement is corrected by a second, opposite movement, which is also how a physical
correction actually works.

---

## 7. Failed-delivery resolution

`FAILED` stays `FAILED`. A resolution is recorded *beside* the failure, never instead of it.

```
                    ┌── RETRY_DELIVERY ──────► a new Delivery, attempt N+1
FAILED delivery ────┼── RETURNED_TO_WAREHOUSE ► a Return
                    └── LOST_OR_UNRECOVERABLE ► nothing comes back
```

### Retry

A new `Delivery` row with `retry_of_delivery_id` and `attempt_number`, carrying the failed
attempt's snapshots forward. It **creates no reservation, consumes no stock, decrements nothing,
raises no warehouse task, and touches no commercial figure** — asserted by tests rather than
trusted, because consuming twice would remove the same units from inventory twice and is the
single most expensive mistake this workflow could make.

A retry is honest only while custody never left the logistics operation. Once a return has
restocked the goods, `assessRetryEligibility` refuses with `GOODS_BACK_IN_WAREHOUSE` and says
why: the units are counted as stock again, so sending them out has to go through the warehouse
so stock is consumed for the trip. That re-fulfilment path is not built, and offering a "retry"
there would be exactly the confusing route §23 warns about.

A partial unique index allows one live retry per attempt, so a double-clicked button cannot put
two vehicles on the road for one shipment.

### Write-off

No stock returns, because there is nothing to return. No payment is touched. What it creates is
a visible obligation — `operationalException = DELIVERY_LOST` — that somebody has to settle
commercially. Settling it is a later phase, and pretending otherwise here would be worse than
leaving it open.

---

## 8. Return state machine

```
EXPECTED ──► RECEIVED ──► INSPECTED ──► COMPLETED
    │            │            │
    └────────────┴────────────┴──► CANCELLED
```

`COMPLETED` is terminal: stock has moved, and there is no operation that un-restocks something.
Cancellation is available right up to that point, because nothing physical has changed yet.

### The arithmetic, pinned by a CHECK

```
received = restockable + damaged
expected = received + missing
```

Both halves matter and they fail differently. Without the first, quantity could be restocked
that was never inspected. Without the second, goods that failed to arrive would drop out of the
sum rather than being recorded as missing — and "eighty went out, seventy-six came back" would
leave four units the history cannot account for.

Before inspection, `quantity_missing` holds the whole expected quantity: nothing has arrived, so
all of it is outstanding. That keeps the identity true at every instant rather than only at the
end. (An earlier version seeded it to zero and the constraint correctly rejected every new
return — see §13.)

`missing` is **derived**, never entered, so the invariant cannot be satisfied by adjusting the
wrong number.

### Restock, damaged, lost

**Only `restockable` increases sellable stock.** Damaged units are physically present and
commercially worthless — putting them back would offer a customer a broken bag of cement. Missing
units are not present at all. Both stay in the return record, because a quantity that disappears
from history is a quantity nobody can be asked about.

The worked example: 80 dispatched, 76 restockable, 4 damaged → `available_stock` +76,
`reserved_stock` unchanged, and the return detail shows all three figures adding to 80.

### No reservation is recreated

The original reservation was consumed when the goods left, and it stays `CONSUMED` — those units
*were* shipped against that order. Returned goods come back as **free stock**, because whether
this customer still wants them is an open commercial question and not one the warehouse should
answer by silently re-committing inventory to them.

---

## 9. Order state and payment independence

A new nullable `SalesOrder.operationalException` (`STOCK_SHORTFALL`, `DELIVERY_FAILED`,
`DELIVERY_LOST`, `GOODS_RETURNED`) rather than a fourth `status` value. A fourth status would
have to be ordered against OPEN, CANCELLED and COMPLETED, and it does not belong in that
sequence: an order with a shortfall is still open, and one whose goods were lost is neither
finished nor cancelled.

An unresolved failure cannot masquerade as completion: Phase 6's `assessCompletion` looks only at
non-cancelled, non-failed deliveries, so a failed run leaves the order `OPEN` with no delivery
to satisfy it. A successful retry then completes it under the unchanged Phase 6 rules — with no
second consumption.

**Payment is never touched.** A paid cash order whose goods were lost stays `PAID`, its
confirmed payments stay `CONFIRMED`, and its balance stays zero. That is a business obligation,
and the product's job is to make it visible rather than to resolve it silently. A return is not a
cancellation and never routes through `cancelOrder()`: the order progressed far beyond the
cancellation boundary, and calling it would try to release consumed reservations and erase four
phases of history.

---

## 10. Transactions and lock ordering

Phase 6's chain is extended by **insertion**, never by prepending:

```
payment → sales_order → warehouse_task → delivery → return
         → inventory_discrepancy → products (ascending id) → reservations
```

Every operation takes the subsequence it needs, left to right. A standalone discrepancy — raised
during a stock count, belonging to no order — takes a suffix of the same chain
(`discrepancy → products`), which is consistent rather than a second convention.

One existing path changed: `completeWarehouseTask` now locks its task's open discrepancies before
locking products. That is in order, and it is what makes a handover racing a reconciliation
serialise instead of interleaving.

**Reconciliation transaction:** lock order (if any) → discrepancy → product; re-read live
on-hand and live ACTIVE reservation total; verify; apply delta; write movement; resolve; audit.

**Return completion transaction:** lock order → delivery → return → products ascending; verify
quantities; increment `available_stock` by the restockable quantity only; write movements; mark
complete; audit. No original reservation is recreated.

No retries and no sleeps anywhere.

---

## 11. Database backstops

- `inventory_movements_delta_non_zero` — a movement that moved nothing is noise in the one
  history a stock dispute is settled from.
- `inventory_movements_stock_after_non_negative`.
- `REVOKE UPDATE, DELETE ON inventory_movements` — the ledger is appended to, never edited.
- `inventory_discrepancies_variance_is_derived` — the stored variance cannot disagree with the
  two figures it comes from.
- `inventory_discrepancies_resolution_matches_status` — resolved implies a resolution type and a
  timestamp, and nothing else may carry them.
- Trigger `inventory_discrepancies_resolved_immutable` — a resolved discrepancy cannot be
  rewritten or deleted.
- `returns_one_live_per_delivery` — partial unique index; two returns against one failed delivery
  would each believe they own the same physical goods.
- `returns_timestamps_match_status`.
- `return_items_quantities_balance` — both halves of the identity, plus every quantity bounded
  above by what was dispatched.
- `deliveries_retry_not_self`, `deliveries_attempt_number_positive`.
- `deliveries_one_retry_per_attempt` — partial unique index.
- `deliveries_resolution_requires_failure`.
- RLS on all three new tables and on the renamed ledger, forced, with the Phase 1
  `nullif(current_setting(...), '')` predicate.

---

## 12. RBAC

| Permission | Warehouse | Sales | Sales Manager | Finance |
|---|---|---|---|---|
| `read:inventory-exception` | ✓ | ✓ | ✓ | ✓ |
| `report:inventory-discrepancy` | ✓ | | | |
| `review:` / `resolve:inventory-discrepancy` | | | ✓ | |
| `resolve:reservation-shortfall` | | | ✓ | |
| `receive:` / `inspect:` / `complete:return` | ✓ | | | |
| `create:return`, `create:delivery-retry`, `resolve:delivery-loss` | | | ✓ | |

Two separations are load-bearing:

- **Counting is not correcting.** The warehouse reports what is on the shelf and cannot write it
  into stock — the same two-pairs-of-hands reasoning that keeps payment submission away from
  payment confirmation.
- **The warehouse never chooses whose order gives way.** It establishes physical reality; sales
  decides commercial priority.

No generic `manage:inventory` or `manage:returns` exists — a test asserts it — because a single
grant would collapse counting, correcting, restocking and reallocating into one and make every
separation above decorative.

---

## 13. Defects found and fixed in this phase

1. **My own CHECK rejected every new return.** `expected = received + missing` is right about the
   end state and was wrong as an always-on invariant: at creation nothing has been received and
   nothing declared missing, so `10 = 0 + 0` failed. The fix was not to relax the constraint but
   to make the pre-inspection state arithmetically true — the whole expected quantity is
   outstanding until it arrives — which is both correct and a stronger guarantee than the
   original, since the identity now holds at every instant rather than only at the end.

2. **`ErrorNote` silently dropped every extra prop.** A `data-testid` passed to it never reached
   the DOM, so an error the tests were asserting on was invisible to them. Named explicitly now.

3. **Prisma would have dropped the Phase 1 stock ledger.** Its generated migration turned the
   rename into `DROP TABLE` + `CREATE TABLE`, which is a correct schema diff and a destructive
   change: every manual stock correction a distributor had recorded would have gone. The
   migration was hand-written as a real rename.

4. **A stale migration checksum, repaired rather than reset.** A Phase 6 migration file corrected
   after it was applied left the dev database's recorded checksum stale, and Prisma's remedy is a
   full reset. Since the database content already matched the corrected file, the precise fix was
   to update the recorded checksum — no data lost, and the result identical to a replay.

5. **Three E2E fixture bugs**, none of them product defects: two `page.url()` reads that outran a
   redirect, and a `getByText` locator asserting a message that was in fact correct and present.

---

## 14. Evidence

- **1225** vitest tests (796 unit, 429 integration and security) against a real PostgreSQL 17.
- **152** Playwright specs across desktop and mobile (146 passed, 6 skipped by their own viewport
  guards).
- `pnpm typecheck`, `pnpm lint` and `next build` all clean.

The seven concurrency cases, each asserting an outcome that would be wrong under a naive
implementation:

| | Behaviour |
|---|---|
| A | Two users reconciling one discrepancy → stock adjusted once, one movement row |
| B | Reconciliation racing a handover → one coherent outcome, never a double decrement |
| C | Double-clicked return completion → restocked once, one `RETURN_RESTOCK` movement |
| D | Return completing while a retry is created → never both goods on the shelf *and* an attempt to deliver them |
| E | Two returns against one failed delivery → exactly one return row |
| F | Double-clicked retry → exactly one new attempt |
| G | Two organizations resolving exceptions at once → no interference, invariants hold in both |

---

## 15. Honest limits

- **A shortage still has no backorder.** An order left short says "80 required, 60 reserved" and
  carries an exception. Turning that into a partial shipment or a revised quotation is a
  commercial conversation the product does not have.
- **A returned load cannot be resent through this workflow.** Once restocked, the goods are
  ordinary stock; sending them again needs a new warehouse task and a new consumption, and that
  re-fulfilment path is not built. The refusal says so rather than offering a route that would
  ship uncounted inventory.
- **Damaged stock has no bucket.** The quantity is preserved in the return record and is simply
  not sellable. A damaged-stock location, write-off valuation, or supplier claim would each be a
  larger model than this phase should introduce.
- **Nothing financial is resolved.** A lost or returned load on a paid order is left visible and
  unsettled. Refunds, credit notes and replacement orders are all deliberately absent.
- **A discrepancy covers one product.** A stocktake across a whole yard would be a different
  workflow; this is the exception a picker hits, not an annual count.
- **All demo data is synthetic.**
