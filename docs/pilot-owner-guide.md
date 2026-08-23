# Owner — Quick Guide

## What the dashboard is for

Four questions, in the order you actually ask them: what happened today, what needs attention,
where is money stuck, where is fulfilment stuck.

Everything on it is calculated by the system in your organization's timezone. Nothing on it is
estimated, predicted or inferred.

## The four figures at the top

| | Exactly what it means |
|---|---|
| **Orders today** | Sales orders raised today, excluding cancelled ones, at their agreed totals |
| **Accepted quotation value** | Quotations a customer accepted today. **Not the same as orders** — a quote accepted today may become an order tomorrow |
| **Confirmed payments today** | Money **Finance verified** today. A customer's claim with a screenshot attached is not counted until somebody confirms it |
| **Overdue receivables** | Owed, past its due date, still outstanding |

They are labelled separately because they are different things, and adding two of them together
produces a number that means nothing.

## Needs Attention

The most useful part. Ordered by severity, then by how long it has been waiting — **never by how
much money is involved**, because a large new problem displacing a small old one buries the one
being forgotten.

**Critical** — money at risk or a promise that cannot be kept: more stock promised than counted; a
paid order whose goods were lost; a count blocking a handoff.

**High** — somebody is waiting and it is costing something: an overdue receivable; a payment claim
unreviewed for more than a day; an unresolved failed delivery; an overdue follow-up.

**Normal** — needs doing, nothing is bleeding.

Every entry links to the screen where you fix it.

## The daily summary

Written from the figures above and nothing else.

If it says **"AI-assisted"**, a model turned those figures into sentences. If it says just
**"Daily summary"**, the system wrote it. The difference is stated because it matters.

**The AI never calculates anything.** Every number exists before it is asked, and a summary
stating a figure the system did not calculate is discarded and replaced with the plain one. It
also never sees a customer name — it gets counts and amounts only.

## What you can do that others cannot

Everything. Practically: set discount limits and the price floor, credit standing and limits,
users and roles, and resolve reservation shortfalls — deciding which customer's order gives way
when the yard cannot cover them all.

That last one is deliberately yours. No rule, heuristic or model picks a customer to disappoint.

## Numbers that will look wrong and are not

**A completed order that still owes money.** Correct, and important. A delivered 30-day credit
order is finished operationally and owes every santim. It stays in receivables until Finance
confirms payment. Completion is about goods, not money — otherwise delivering an order would erase
the debt.

**Acceptance rate showing "none decided".** Nothing was accepted *or* rejected today. That is not
zero percent, which would read as having lost everything.

**A trend with no percentage.** The previous period was zero. Going from nothing to something is
not an increase of any percentage.

**Stock that did not move when the warehouse marked an order prepared.** Correct. Picked goods are
still in the yard. Stock moves when they leave.

## What is not real, and you should know it

- **No OCR verifies anything with a bank.** Payment extraction reads a photograph into a
  suggestion. Finance's eyes are the verification. Nothing contacts a bank or Telebirr.
- **Nothing is sent to your customers.** No WhatsApp, SMS or email. Quotations go out however they
  go out today.
- **There is no accounting here.** No profit, no margin, no cost of goods — the system does not
  know what you paid for anything. "Order value" is what a customer agreed to pay.
- **No forecasting and no reorder advice.** It will tell you six products are below their
  threshold. It will not tell you how much to buy.

## The one operational thing to check weekly

**That backups ran and that a failure would reach a person.** Everything else in this system is
recoverable. Data loss is not.
