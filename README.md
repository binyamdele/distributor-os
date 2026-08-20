# Distributor OS

An AI operating assistant for medium-sized construction-material distributors in Addis Ababa.

The narrow promise:

> Turn customer inquiries into quotations, orders, follow-ups, payments and delivery handoffs
> with dramatically less manual work.

**Status: Phase 1 of 8 — foundation.** Organizations, users, roles, customers, products,
aliases, stock adjustment and the audit log are built and tested against a real PostgreSQL.
Inquiries, AI parsing, quotations, approvals, follow-ups, orders, payments, warehouse and
delivery handoff are **not built yet**. See [what exists](#what-exists) for the honest split.

---

## The idea

Most software sold to distributors is an ERP that assumes the business will change to fit it.
This one starts from the single workflow that costs a distributor the most hours — the path
from a customer's WhatsApp message to a delivered order — and automates the retyping without
taking away the decisions.

Three constraints shape every part of it:

- **AI proposes; a person decides.** Quotations, discounts, price overrides, customer-facing
  messages, payment confirmation and credit changes all require an explicit human approval. No
  model can mark a payment received or invent a price.
- **Business truth is deterministic.** Prices, stock, credit limits, VAT and totals come from
  the database and from integer arithmetic — never from a language model. The AI interprets,
  summarises and drafts; it is never the system of record.
- **Every material change is auditable.** Who, what, when, from what state to what state, and
  whether AI was involved — written in the same transaction as the change itself.

## Multi-tenancy

Several distributors share one deployment, and a leak between them would end the product. The
guarantee has three independent layers:

1. **A Prisma client extension** injects the organization filter into every query. Forgetting
   to scope a query is not something a developer can do — and an ESLint rule blocks importing
   the raw client outside `src/platform/db`.
2. **Row-Level Security** in PostgreSQL, keyed on a transaction-local session variable. The
   application connects as a `NOSUPERUSER` role specifically so the policies bind to it.
3. **Tests that enumerate the schema** rather than a hand-written list, so a table added in a
   later phase cannot silently opt out of tenancy.

## Money

Every amount is a `bigint` count of minor units (santim) with an explicit currency. There is no
float anywhere in the money path, no `Decimal`, and no `number`. Rates — VAT, discounts, price
floors — are integer basis points. Rounding is half-up, per line, so displayed line totals
always add up to the displayed grand total. That last property is what a customer checks by
hand, and getting it wrong once costs more trust than every other feature earns.

---

## Quick start

Requires Node 20+, pnpm 9 and Docker.

```bash
pnpm install
cp .env.example .env

# Generate a session secret and paste it into .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

pnpm db:up          # PostgreSQL on :5434
pnpm db:deploy      # apply migrations
pnpm db:seed        # demo data
pnpm dev            # http://localhost:3000
```

**No API key is needed.** `AI_PROVIDER` defaults to `mock`, and the whole application runs and
tests without one.

### Demo accounts

All use the password `DemoPassword2026`. The data is synthetic — the prices are plausible round
numbers chosen to make demo arithmetic legible, and **do not reflect real Ethiopian market
prices**.

| Role | Email |
|---|---|
| Owner / Admin | `owner@addisbuild.example` |
| Sales Manager | `manager@addisbuild.example` |
| Salesperson | `sales@addisbuild.example` |
| Finance | `finance@addisbuild.example` |
| Warehouse | `warehouse@addisbuild.example` |

A second organization, **Rift Valley Trading PLC**, is seeded as a tenancy canary: if you ever
see its customers or its gravel while signed in to Addis Build Supply, something is badly wrong.

---

## What exists

| Built and tested | Not built yet |
|---|---|
| Organizations, settings, number sequences | Inquiry capture and channel adapters |
| Users, memberships, sessions, login | AI inquiry parsing |
| Role-based access control (5 roles, 33 permissions) | Deterministic product matching |
| Customers, with credit standing and terms | Quotations, pricing, approval rules |
| Products, aliases, stock adjustment with reasons | Follow-ups and order conversion |
| Append-only audit log with per-tenant ordering | Payment review and finance confirmation |
| Three-layer tenant isolation | Warehouse and delivery handoff |
| Money arithmetic in integer minor units | Dashboard metrics and the daily brief |

Nothing in this checkout has ever contacted an external system. There is no messaging
integration, no payment integration and no OCR — those arrive as adapters in later phases, and
will be labelled as simulated until they are not.

---

## Commands

```bash
pnpm dev            # development server
pnpm build          # production build
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint, including the architectural rules
pnpm test           # unit + integration (integration needs pnpm db:up)
pnpm test:e2e       # Playwright, desktop and mobile, against a production build
pnpm verify         # typecheck + lint + test

pnpm db:up          # start PostgreSQL
pnpm db:migrate     # create a migration from schema changes
pnpm db:deploy      # apply migrations
pnpm db:seed        # load demo data (idempotent)
pnpm db:reset       # drop, re-migrate, re-seed
```

Ports: PostgreSQL is on **5434**, deliberately, to avoid colliding with other projects.

---

## Architecture

A pragmatic modular monolith: one Next.js application, one PostgreSQL database, modules
separated by directory and by an enforced dependency direction.

```
src/app/           Next.js App Router — pages, server actions, the HTTP boundary
src/modules/       business logic; no HTTP and no React inside
  audit/           the append-only mutation log
  identity/        authentication and sessions
  customers/
  catalog/         products, aliases, deterministic normalisation
src/platform/      cross-cutting and domain-free
  money/  db/  security/  rbac/  i18n/  config/  result/  context/
src/components/ui/ small shadcn-idiom primitives
```

**Dependency rule:** `app` → `modules` → `platform`. Never upward, and never sideways between
modules except through a module's public index. ESLint enforces it.

Full reasoning, the domain model, the risk register and what is deliberately excluded:
[`docs/architecture-baseline.md`](docs/architecture-baseline.md).

Other documents:

- [`docs/future-roadmap.md`](docs/future-roadmap.md) — what is deliberately not built, and the seam left for it
- [`docs/customer-discovery.md`](docs/customer-discovery.md) — interview guide
- [`docs/validation-scorecard.md`](docs/validation-scorecard.md) — build / pivot / kill criteria

---

## Localisation

English ships first; Amharic is architected for from the first commit. Every user-visible
string is a key in `src/platform/i18n`, the `am` catalogue is partial and falls back per key,
and all date formatting is isolated in one module so the Ethiopian calendar can be added later
without touching components. Times are always in the organization's timezone, never the
server's.
