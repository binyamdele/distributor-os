# Sales — Quick Guide

## What you do

Turn customer enquiries into quotations, chase them, and raise the order when a customer agrees.

## What you cannot do, and why

| | Why |
|---|---|
| Confirm a payment | You attach the customer's screenshot; Finance decides it is money. Two pairs of hands on every payment |
| See the payment evidence back | Same reason. You can submit one, you cannot read one |
| Approve a discount above your limit | The system routes it to your manager automatically |
| See receivables | Sales managers do; salespeople do not |
| Change stock, or send goods out | That is the warehouse |

None of this is distrust. It is what keeps a mistake from becoming a loss nobody can trace.

## Your day

**1. New enquiry** — Inquiries → New. Paste what the customer sent, word for word. Choose the
customer if you know them.

**2. Parse** — press *Run parse*. It reads the message into a list of products and quantities.

**3. Check every line.** This is the important step. It matches on name and alias and it is
sometimes wrong. Confirm, correct or reject each one. If the customer wrote something the system
does not stock, say so — do not substitute.

**4. Mark ready** → *Create quotation*. Prices come from the catalogue. Set payment terms; a
cash-only customer cannot be given credit.

**5. Submit for approval.** Within your discount limit you can approve it yourself. Above it, your
manager gets it.

**6. Mark as sent** once you have actually sent it. Follow-ups schedule from that moment.

**7. Follow up.** The queue tells you who to chase and when. Record what they said, including "no
answer" — that is data too.

**8. Record the outcome.** Accepted or rejected, with the reason.

**9. Create the sales order.** Stock reserves now, held for this customer. If there is not enough,
you are told exactly how short — talk to the customer, do not adjust anything.

**10. Payment.** For a cash order, when the customer sends proof, attach it under the order.
Finance takes it from there. **The goods do not move until Finance confirms.**

## When you are blocked

| | |
|---|---|
| "Requires manager approval" | Your discount exceeds your limit. Ask your manager |
| "Only 240 in stock" | Exact figure. Offer less, offer an alternative, or ask the warehouse |
| Customer is `CASH_ONLY` or `SUSPENDED` | Credit terms are refused. Finance sets credit standing |
| Parse produced nothing useful | Type the lines in by hand. The message is kept as written |
| Order will not cancel | Something has happened — a confirmed payment, or the warehouse has started. The message says which |

## Never work around these

- **Do not edit an approved quotation to change a price.** The approval covers exact figures; edit
  it and it needs approving again. That is deliberate.
- **Do not create a second customer record** because the name is spelled differently. One
  customer, one ledger.
- **Do not record an acceptance you have not had.** It reserves stock other customers could buy.
- **Do not tell a customer their goods are coming** before the order says ready.
