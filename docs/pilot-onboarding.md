# Pilot Onboarding

Getting one real distributor from nothing to live. Written as a sequence because the order
matters — several steps depend on the one before, and doing them out of order produces confusing
failures rather than clear ones.

Budget half a day for steps 1–11 and a week for training and the parallel run.

---

## Before the first command

- [ ] production deployed and `/api/health/ready` green ([`deployment-runbook.md`](deployment-runbook.md))
- [ ] a backup taken and a **restore drill run against production** ([`backup-and-restore-runbook.md`](backup-and-restore-runbook.md))
- [ ] the distributor has exported three spreadsheets: customers, products with prices, current stock counts

That second item is not ceremony. Onboarding writes a distributor's whole commercial reality into
a system nobody has yet proved they can recover.

---

## 1. Create the organization and its owner

```bash
pnpm admin:create-organization \
  --name "Addis Build Supply PLC" \
  --timezone Africa/Addis_Ababa \
  --currency ETB \
  --owner-email owner@example.com \
  --owner-name "Full Name"
```

The password is printed **once** and stored only as a scrypt hash. Give it to the owner over a
channel you trust and have them change it.

The timezone is not cosmetic: every "today", "overdue" and "due soon" on the dashboard is computed
in it. Getting it wrong makes every figure quietly wrong by the offset.

## 2. Create the other users

Owner signs in → **Settings → Users**. One account per person, never a shared one — every
approval, confirmation and stock movement is attributed, and a shared login makes the audit trail
worthless exactly when it is needed.

## 3. Roles

| Role | Holds | Notably does not |
|---|---|---|
| Owner/Admin | everything | |
| Sales Manager | quotations, approvals above the salesperson limit, orders, cancellation, deliveries, exception resolution | confirm payments, consume stock |
| Salesperson | inquiries, quotations within their limit, orders, payment evidence submission | approve beyond limit, confirm payments, see receivables |
| Finance | payment review and confirmation, receivables, credit limits | create or price quotations, touch stock |
| Warehouse | picking, handover, stock adjustment, returns, collections | see prices or payment evidence, drive deliveries |

Two separations are load-bearing and worth explaining out loud during training:

- **Whoever submits a payment claim cannot confirm it.** Sales attaches the customer's screenshot;
  Finance decides it is money. Two pairs of hands, always.
- **Whoever picks the goods cannot declare them delivered.** Otherwise one person could close an
  order end to end with nobody else involved.

## 4. Settings

**Settings → Organization**: discount limits (salesperson and manager), the minimum price floor,
default payment terms, quote validity, follow-up interval and cap, and whether delivery charges
attract VAT.

Ask the owner for the real numbers rather than accepting the defaults. The defaults were chosen to
make a demo legible, not to reflect anyone's business.

## 5. Import products

```bash
pnpm admin:import --org <id> --kind products --file ./products.csv
# read the preview, fix the file, then:
pnpm admin:import --org <id> --kind products --file ./products.csv --commit
```

Template: [`import-templates/products.csv`](import-templates/products.csv).

Expect the first preview to fail. The common causes are units outside the accepted list, prices
written with a comma decimal separator, and duplicate SKUs — all reported with line numbers.
**Fix the spreadsheet, not the importer.**

## 6. Import opening stock

```bash
pnpm admin:import --org <id> --kind opening-stock --file ./stock.csv --commit
```

Products must exist first. Each product gets an `OPENING_BALANCE` movement, so from day one the
ledger can explain where every quantity came from.

**This can only be done once per product.** A second attempt is refused — by the file fingerprint
and, for a different file, by the fact that the product already holds stock. Importing a stock
count twice doubles the yard invisibly: every figure stays plausible and nobody finds out until a
physical count disagrees weeks later. To correct a bad opening count, use a stock adjustment,
which is a second recorded fact.

## 7. Import customers

```bash
pnpm admin:import --org <id> --kind customers --file ./customers.csv --commit
```

Credit status matters: `CASH_ONLY` customers cannot be given credit terms on a quotation, and
`SUSPENDED` ones are blocked by the approval rules. Confirm each with the owner rather than
importing whatever the spreadsheet says.

## 8. Check the totals

Sign in as the owner and compare against what the distributor believes:

- [ ] product count matches the spreadsheet
- [ ] spot-check five prices against the price list
- [ ] stock figures match the count sheet
- [ ] customer count matches, and credit limits look right
- [ ] the dashboard shows sensible low-stock counts and no receivables

**Do not skip this.** Everything afterwards is built on these numbers.

## 9. One synthetic run-through

With the owner watching, on a customer named clearly as a test:

inquiry → parse → review matches → quotation → approve → send → record acceptance → sales order
(stock reserves) → payment evidence → Finance confirms → warehouse task → pick → hand over (stock
consumes) → delivery → delivered → order completes → dashboard updates → audit trail visible.

Then **cancel or complete the test order** so it does not pollute the real figures.

This is the moment the distributor sees the whole thing work, and the moment you discover a
setting that is wrong.

## 10. Train

Half an hour per role, using their own data. Guides:
[sales](pilot-sales-guide.md) · [finance](pilot-finance-guide.md) ·
[warehouse](pilot-warehouse-guide.md) · [owner](pilot-owner-guide.md).

## 11. Go live

- [ ] every user has signed in and changed their password
- [ ] backups are scheduled **and a failure is visible to a human**
- [ ] the uptime check on `/api/health/ready` is live
- [ ] somebody owns the support channel and knows about
      [`pilot-issue-template.md`](pilot-issue-template.md)
- [ ] the owner knows what is mocked ([`pilot-readiness.md`](pilot-readiness.md) §"What is not
      real")

**Run in parallel with their existing process for the first week.** Not because the system is
expected to fail, but because the failure mode that matters — a wrong number nobody notices — is
only visible against a second source of truth.

---

## What to tell the distributor plainly

- **Payment evidence is read by a person, always.** No OCR verifies anything with a bank; the
  extraction is an assistant and Finance decides.
- **Nothing is sent to customers.** No WhatsApp, no SMS, no email. Quotations are shared however
  they are shared today.
- **The AI never decides anything.** It reads messages into a draft a person reviews, and writes
  the daily summary from figures the system calculated. It cannot set a price, mark a payment or
  change stock.
- **A failed delivery does not return goods to stock.** The goods are somewhere; a return is a
  separate, counted event.
