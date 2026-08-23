# Finance — Quick Guide

## What you do

Decide whether money actually arrived, and chase what has not.

Yours is the decision that releases goods. Nothing ships on a cash order until you confirm.

## What you cannot do, and why

| | Why |
|---|---|
| Submit payment evidence | Sales attaches it, you confirm it. Two pairs of hands on every payment — you holding both halves is the one thing that would make the gate meaningless |
| Create or price a quotation | You chase what is owed; you do not set what is charged |
| Touch stock, pick or deliver | That is the warehouse |

## Your day

**1. Payments to verify.** Oldest first. For each one you see, side by side: what the order is
for, what the customer claims, what was read off the evidence, and the evidence itself.

**2. Read the match notes.** Deterministic checks, not a score:

- *Exact amount match* — the claim equals what is outstanding
- *Amount below outstanding* — a part payment. Legitimate, and the order stays unreleased
- *Duplicate reference* — this reference is already on a confirmed payment. **Stop.** Either a
  double claim or a typo, and the note deliberately does not tell you which other order, because
  that would leak another customer's business
- *Payer name differs* — often fine (a company paying via a director). Worth a glance
- *Claim differs from evidence* — the typed figure and the slip disagree. Correct the metadata
  before confirming

**3. Confirm or reject.**

Confirming records the exact figures you saw. If anything changes afterwards, the confirmation no
longer applies and it comes back to you — that is deliberate, not a bug.

- Full amount → order becomes **paid** and **ready**, warehouse can start
- Part amount → **partly paid**, and the goods stay put
- Rejecting requires a reason. Sales sees it and can talk to the customer

**4. Receivables.** Overdue first, longest overdue first, then largest. No cleverness, so you can
predict it.

**5. Credit standing.** You set limits and status. `CASH_ONLY` blocks credit terms outright;
`SUSPENDED` blocks new credit orders.

## Things that will look wrong and are not

**A completed order still owing money.** Correct. A delivered 30-day credit order is finished
operationally and owes every santim. Completion is about goods, not money.

**A paid order whose delivery failed.** The payment stays confirmed. Goods left and did not
arrive; that is an obligation to settle commercially, and the system will not quietly reverse a
payment to tidy it up.

**A confirmed payment cannot be edited.** Deliberate — the database itself refuses. A correction
is a second recorded payment or an adjustment, never a rewrite of the first.

## When you are blocked

| | |
|---|---|
| Evidence unreadable | Reject with a reason, ask sales for a better photograph |
| Duplicate reference | Do not confirm. Check with the customer and with the other order |
| Amount does not match | Correct the metadata to what the slip says, then decide |
| Extraction produced nothing | Type it in. The extraction is an assistant, not a requirement |

## What is not real

**No OCR verifies anything with a bank.** The extraction reads a photograph into a suggestion.
Nothing in this system contacts a bank or Telebirr, and nothing confirms a transfer independently.
**Your eyes on the evidence are the verification.**
