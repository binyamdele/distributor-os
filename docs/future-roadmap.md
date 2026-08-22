# Future Roadmap — Deliberately Not Built

This file exists so that good ideas have somewhere to go other than into the MVP.

Nothing on this page is being implemented. When a temptation appears during development, it is
recorded here and the work continues. Anything not on the critical inquiry-to-delivery path is
deferred by default.

---

## 1. Excluded by the product brief

Payroll · HR · full accounting · general ledger · procurement · supplier marketplace · fleet
optimisation · advanced warehouse management (bin locations, barcodes, picking optimisation) ·
route optimisation · real-time vehicle tracking · ML forecasting · automatic purchasing ·
autonomous credit decisions · lending · banking integrations · complicated CRM · customer
support chatbot · mobile apps · microservices · Kubernetes · complex event streaming ·
blockchain · unnecessary AI agents.

---

## 2. Deferred by the Phase 0 assessment, with the seam that was left

| Deferred | Why now is wrong | Seam left in the code |
|---|---|---|
| Real WhatsApp / Telegram / SMS sending | No credentials, and the value hypothesis does not depend on it. Simulated sends prove the workflow. | `ChannelAdapter` interface; inbound channel adapters; messages recorded as `sent_simulated` and labelled as such in the UI |
| Real OCR of payment slips | Extraction accuracy is a research problem that does not change the finance approval gate, which is the part that matters | `PaymentExtractor` interface, a mock implementation, and manual entry |
| Redis, job queues, background workers | Follow-up due dates are a query, not a scheduling problem, at MVP volume | Follow-up computation isolated in one module so a scheduler can drive it later |
| S3-compatible object storage | Local disk is sufficient for a pilot | `FileStore` interface |
| Multi-currency | ETB only for the first market | Currency column and money type carry an explicit currency from day one |
| Amharic UI translation | Launch in English; translate once the workflow is validated | i18n from the first commit; `am` catalogue stubbed; no hard-coded UI strings |
| Ethiopian calendar dates | Gregorian plus `Africa/Addis_Ababa` is enough for a pilot | All date formatting isolated in one module |
| PDF quotation generation | A shareable quote page tests the same hypothesis at a fraction of the cost | Quote rendering separated from quote transport |
| Withholding tax, credit notes, partial payments, payment allocation across invoices | Real accounting depth, well past the first promise | Payments modelled per order with an explicit amount, so allocation can be added |
| Self-serve signup, billing, subscription management | Pilot organisations are created by hand | Organizations are first-class from day one |
| Price lists per customer segment, contract pricing, volume breaks | Needs evidence that distributors actually price this way | Prices snapshot onto quotation lines, so a pricing source can change without rewriting history |
| Learned aliases from salesperson corrections | Worth doing, but only once there are corrections to learn from | `product_aliases.source` already distinguishes `seed | manual | learned` |
| Embeddings / vector search for product matching | Phase 2 explicitly excludes it, and the deterministic matcher is doing well on the demo corpus. Revisit only if the correction rate says otherwise | The matcher is a pure function over a corpus; a different scorer swaps in behind the same signature |
| SQL-side candidate pre-filtering via the trigram index | The whole catalogue is loaded per parse. Fine at a few hundred SKUs, wrong at tens of thousands | `product_aliases_normalized_trgm` GIN index already exists; `loadMatchCorpus` is the single place to change |
| Preserving human review across a re-parse | Carrying a confirmation onto a line that may no longer be the same line is worse than asking again | Proposals are rebuilt wholesale, so a future line-identity scheme has nothing to unpick |
| Unit conversion (bags ↔ kg, quintal ↔ ton) | Needs a per-product factor nobody has entered; guessing puts a confident wrong number on a quotation | `checkUnit` returns `mismatch` with a reason rather than converting |
| Amharic alias coverage at scale | A handful are seeded; a real deployment needs many more | Aliases are rows, added without a migration |
| PDF quotations | A dependency sink, and the in-app view tests the same hypothesis | Quotation rendering is separate from quotation transport |
| A customer-facing shareable quotation link | Needs a public route, a token scheme and an expiry policy — a security surface of its own | The quotation view already reads only from snapshots |
| Direct unit-price override | Discounts are explicit and visible to an approver; an edited price hides the size of the concession | `quoted_unit_price_minor` exists and equals list; an override needs no migration |
| Superseding a sent quotation with a revision | The state exists; the workflow does not | `SUPERSEDED` is in the state machine and reachable |
| A job that expires quotations past their validity date | Needs a scheduler, which the MVP deliberately does not have | `validityDate` is stored; `EXPIRED` is in the state machine |
| AI-drafted customer-facing quotation wording | Optional in Phase 3, and correctness came first | The `AIProvider` seam takes a new capability without touching the pricing path |
| Multi-currency quotations | ETB only | Currency is on the quotation and in the approval payload |
| A second approval tier above the sales manager | Rule C blocks by design; raising the configured limit is the audited alternative | `ApprovalLevel` is an enum; `rolesSatisfying` is one function |
| Purchase orders and supplier-side inventory replenishment | Different workflow, different buyer | Stock adjustments carry a reason code |

---

## 3. The longer arc (documented only)

The intended evolution, in the order in which each step earns the right to exist:

AI quotation assistant → sales automation → distributor operating system → inventory
intelligence → delivery and logistics → procurement → supplier network → buyer network →
payments → demand intelligence → Ethiopian B2B commerce infrastructure → East Africa expansion.

Extension seams to protect while building the MVP, without building any of them:

- **Inventory intelligence** — reorder recommendations and demand forecasting need clean
  historical stock movements. Keep `stock_adjustments` complete and reasoned from Phase 1.
- **Procurement and supplier network** — needs a supplier entity that does not exist yet. Do
  not add a placeholder table "for later"; add it when the workflow is real.
- **Payment integrations** — the `PaymentExtractor` and payment-status boundaries are already
  the right seam. Confirmation stays a human action regardless of which integration arrives.
- **Geospatial delivery intelligence** — `deliveries.destination_text` is free text on purpose.
  A structured address or coordinate pair can be added beside it without a migration of meaning.
- **Financing partnerships** — depend on receivables history being trustworthy, which is a
  reason to keep the receivables calculation deterministic and auditable now.

The MVP must not be damaged by trying to build any of this prematurely. The point of the
roadmap is to make deferral cheap, not to schedule the work.

---

## 4. Deferred by the Phase 4 assessment

| Deferred | Why now is wrong | Seam left behind |
|---|---|---|
| AI-drafted follow-up messages | Optional in the brief, and the queue must work with a provider unreachable. Reservation correctness was the better use of the phase | The `AIProvider` seam takes a `draftFollowUp` capability without touching the queue |
| Backorders and partial fulfilment | All-or-nothing reservation is safer for an MVP; a short conversion is refused with exact numbers and a person decides | `planReservation` already computes the per-product shortfall a backorder would need |
| Product substitution on a short line | Needs an equivalence model nobody has entered | The refusal names the product and the gap |
| Quote revision after acceptance | An accepted quotation is immutable commercial history; revising it means a superseding quotation, and that flow does not exist | `SUPERSEDED` is in the quotation state machine |
| Stock consumption on dispatch | Goods leaving the yard is warehouse work | `ReservationStatus.CONSUMED` exists and is unreached |
| Reassigning a follow-up to another salesperson | Assignment is the sender today; reassignment needs a UI and a policy | `assigned_user_id` is on the row |
| A sweep that marks quotations `EXPIRED` | Needs a scheduler, which the MVP deliberately lacks | Acceptance already refuses an expired quotation |
| Paging the follow-up queue | Capped at 200, which is beyond pilot volume | The queue is one query |
| Snoozing from the original due date rather than from now | Repeated snoozing drifts the schedule; acceptable until it is used heavily | Snooze is one function |
| A retry policy for lock contention | Deterministic lock ordering removed the need; a retry would have hidden whether the ordering worked | Lock order is one exported function, `lockOrder` |

---

## 5. Deferred by the Phase 5 assessment

| Deferred | Why now is wrong | Seam left behind |
|---|---|---|
| Real OCR on payment receipts | A mock that invents plausible figures makes the pipeline look finished while hiding how much manual correction the real thing needs. The workflow must be correct with extraction unavailable | `PaymentExtractor` takes bytes and returns the fenced schema; swapping the implementation touches `src/platform/payments/index.ts` and nothing else |
| Real payment-provider integration (Telebirr, bank APIs) | Confirmation stays a human action regardless of which integration arrives, so the gate is the valuable half and it is built. An integration would only pre-fill the claim | `PaymentMethod` and `provider_name` already carry the provider; a feed would create `SUBMITTED` rows through the same path staff use |
| Refunds, credit notes and reversals | A confirmed payment is immutable by trigger, deliberately. Correction is a second recorded fact, and designing that needs the accounting model a pilot has not yet demanded | The immutability trigger and terminal states make a reversal the only possible shape |
| Allocating an overpayment to another order | Requires a customer credit balance, which is an accounting concept the MVP does not have | Overpayment is audited with disposition `unallocated`, never absorbed |
| Bank-feed reconciliation | Depends on an integration that does not exist, and on references being reliable, which they are not yet | The partial unique index on confirmed references is the deduplication a feed would need |
| Dunning messages and statements | Nothing in this product sends anything to a customer yet, and receivables must be trustworthy before they are mailed out | `receivables()` returns the rows a statement would render, with contact details |
| Scheduled ageing or an overdue sweep | The MVP deliberately lacks a scheduler; buckets are derived per request | `bucketFor` is a pure function of a due date and a clock |
| Paging the payment queue and receivables | Capped at 200 and 500, beyond pilot volume | Both are one query |
| S3-compatible evidence storage | Local disk is right for a pilot, and the interface is what matters | `FileStore` has four methods and no URL method; `fileStore()` is the only place a backend is named |
| Partial confirmation (accepting less than the claim) | Finance confirms what is on the slip; accepting a different figure is a data-entry correction followed by a confirmation, which already works | `amount_confirmed_minor` is separate from `amount_claimed_minor` and both are in the fingerprint |

---

## 6. Deferred by the Phase 6 assessment

| Deferred | Why now is wrong | Seam left behind |
|---|---|---|
| Partial fulfilment and split shipment | A half-shipped order is a commercial exception needing a conversation, not a checkbox. An API that accepts "8 of 12" is one that will eventually be used to ship 8 of 12 | `planConsumption` already computes the exact per-product gap a partial flow would need, and the refusal names it |
| Backorders and substitution on a short pick | Same reason Phase 4 deferred them at reservation: they need an equivalence model and a customer conversation | The blocked completion names the product and both quantities |
| Returns and failed-delivery restocking | Goods that left the yard are somewhere the software does not know about. Putting quantity back would invent inventory nobody has counted | `adjustStock` exists and is deliberately unconnected to fulfilment; a return is a counted event with its own audit meaning |
| Refunds and payment reversal | A confirmed payment is immutable by trigger. Correction is a second recorded fact, and its accounting model has not been asked for | Phase 5's terminal payment states make a reversal the only possible shape |
| Proof of delivery (signature or photograph) | Without one, the product must not call staff confirmation "verified" — and it does not. Adding capture means image storage, consent and retention decisions | Evidence storage from Phase 5 already handles authenticated tenant-scoped files |
| Driver accounts and a driver mobile app | A pilot distributor has three drivers and knows their names. Accounts mean invitations, credentials and a second UI to maintain | `assigned_driver_name` / `_phone` are plain fields; a driver id can sit beside them |
| Vehicle fleet database | Same reasoning. A plate number is what the operation actually uses | `vehicle_reference` is free text |
| Route optimisation, maps, geocoding, ETAs | All depend on a structured address the product does not have, and none of them makes an undelivered order arrive | `destination_text_snapshot` is plain text on purpose; coordinates can be added beside it |
| Live GPS tracking | Needs a driver device and a driver app, and answers a question ("where is the lorry") that a phone call already answers at this scale | Dispatch and delivery timestamps already bound the window |
| Customer notifications on fulfilment events | Nothing in this product sends anything yet, and the statuses must be trustworthy before they are broadcast | The status transitions are the events a notifier would subscribe to |
| Barcode scanning, bin locations, warehouse zones, picking optimisation | A yard with six SKUs does not have a picking problem. These solve congestion the pilot does not have | Task items carry the SKU snapshot; a location column is additive |
| Reassigning a warehouse task between pickers | Assignment is whoever started it; reassignment needs a UI and a policy | `assigned_user_id` is on the row and nullable |
| Paging the warehouse and delivery queues | Capped at 200, beyond pilot volume | Both are one query |
| Requiring assignment before dispatch | Would be a field to fill in rather than a control, at this scale | `assignedAt` distinguishes an assigned delivery from an unassigned one |
| Procurement, supplier management, accounting ledger | Whole products, none of which the narrow promise covers | Stock adjustments and consumed reservations are the raw material a ledger would read |

---

## 7. Deferred by the Phase 7 assessment

| Deferred | Why now is wrong | Seam left behind |
|---|---|---|
| Refunds, credit notes, payment reversal | A confirmed payment is immutable by trigger, and correcting money is a second recorded fact whose accounting model has not been asked for. Phase 7 makes the obligation visible instead of resolving it silently | `operationalException` on the order names the unsettled case; confirmed payments are untouched and complete |
| Customer credit balance | Follows refunds. Without one, a returned load has nowhere to become a credit | The return records exactly what came back in what condition, which is the input a credit would need |
| Replacement orders and automatic reship after restock | Restocked goods are ordinary free stock. Sending them again needs a new warehouse task and a new consumption; automating it would ship inventory the system still counts | `assessRetryEligibility` refuses with `GOODS_BACK_IN_WAREHOUSE` and says what the honest route would be |
| Backorders, split shipment, substitution after a shortfall | Same reason Phases 4 and 6 deferred them: a short order is a commercial conversation, and the software's honest contribution is to name the gap | The order carries `STOCK_SHORTFALL` with required and reserved both visible; the accepted quantities are untouched |
| A damaged-stock bucket | A second stock location means a second set of movements, a valuation question and a disposal workflow. The quantity is preserved without any of that | `quantity_damaged` on the return item; a movement type could route it to a location later |
| Supplier returns, warranties, RMA portal, customer self-service returns, return shipping labels | All assume a counterparty workflow the product does not have. A pilot distributor arranges returns by telephone | The `Return` record is the physical event; who arranged it is a field away |
| Stocktake across a whole yard | A discrepancy is the exception a picker hits, not an annual count. A stocktake needs a session, a freeze and a variance report | `InventoryDiscrepancy` is per-product; a `stocktake_id` would group them |
| Automatic reservation reallocation on a shortfall | Deciding whose order gives way is a conversation with a relationship behind it. Any ranking — by age, value, or a model — would make that decision while appearing to display information | The affected orders are listed unranked with quantities and dates; the action is one explicit permission |
| Batch and lot tracking, serial numbers, expiry | Cement and rebar are fungible at this scale. Adding lots means every reservation, consumption and return becomes lot-specific | Movements already carry the reservation they came from |
| Accounting entries and a general ledger | A whole product, and the narrow promise does not cover it | `inventory_movements` is the raw material a ledger would read, deliberately shaped as inventory history rather than as journal entries |
| Procurement triggered by variance | Reordering on a shortage would act on a number nobody has confirmed yet | The reconciled variance is queryable per product |

---

## 8. Deferred by the Phase 8 assessment

| Deferred | Why now is wrong | Seam left behind |
|---|---|---|
| Forecasting, demand prediction | Nothing in the data supports a prediction, and a confident forecast on a pilot's first quarter would be a fabrication with a chart around it | The seven-day series and the trend comparison are the honest inputs a forecast would need |
| Reorder recommendations, automated purchasing | "Six products are below their threshold" is a fact; "order 10,000 bags" needs lead times, supplier prices and cash position the product does not hold | Low stock is already computed per product from the free-stock rule |
| Supplier recommendations, procurement | No supplier exists in the model at all | — |
| Credit scoring, customer risk ranking | Ranking customers by risk is a policy decision with a relationship on the other end. Phase 7 refused the same thing for reservation shortfalls | Receivables already carry days overdue and payment history per customer |
| Employee performance scoring | The data would support it and the product should not. A quotation count is not a person's worth, and a dashboard that implied otherwise would change behaviour for the worse | Quotations already record who raised them |
| AI business decisions, automatic follow-ups, automatic collection messages | Phase 8's whole contract is that the model narrates and never acts. An automatic message is an action with a customer at the far end | The narration seam takes figures and returns prose; it has no way to reach a record |
| Historical dashboard and historical brief | Would need persisted snapshots, which is a second source of truth. Nobody has asked to read last Tuesday yet | `getDashboardSnapshot` already takes `asOf`, and `snapshotHash` already binds a narrative to its figures |
| Accounting statements, P&L, COGS, gross margin | There is no cost basis anywhere in the product, so every one of these would be invented. Calling something "profit" without a cost is the most damaging number a dashboard could show | Order and payment values are exact; a cost field on the product is where this would start |
| Tax filing and VAT returns | VAT is calculated per line and stored; a return is a regulatory artefact with a filing format and a deadline, and getting it wrong has legal consequences | `taxTotalMinor` is exact on every quotation and order |
| PDF export, email or WhatsApp delivery of the brief | Delivery means scheduling, retries, addresses and an outbound channel — a phase of its own, and the brief is worth reading on the page first | The brief is a plain structure; a formatter for another medium reads the same object |
| Scheduled jobs and push notifications | No scheduler exists in the product, and adding one to send a daily email would be building the infrastructure before the demand | The snapshot is a pure function of time and tenant |
| Cross-company benchmarking | Would require sharing one distributor's figures with another. The tenancy model exists precisely to make that impossible | — |
| Redis or a materialised cache | Measured at ~516 ms over 3,000 quotations, which is comfortable. A cache is a second source of truth and an invalidation problem, bought before there is a bill to pay | Every figure is one function in `definitions.ts` |
| Reporting indexes | Trialled and measured as making no difference at pilot scale; the tenant index already carries the predicates. Adding them would cost write throughput on every order to buy nothing | The measurement test runs in CI, so the decision can be revisited against real data |
