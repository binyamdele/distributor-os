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
