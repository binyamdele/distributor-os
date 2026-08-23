# Pilot Measurement Plan

What to measure during the parallel pilot, and how.

**The critical metric is not whether people liked the interface.** It is:

> Did both systems agree on consequential business numbers?

Everything else is secondary to that. A pilot where staff enjoyed the software and the stock
figures drifted is a failed pilot; one where the interface annoyed everybody and every number
reconciled is a successful one with a design backlog.

---

## 1. How the parallel period works

**One week minimum, both systems running.** The distributor keeps doing whatever they do today —
Excel, a quotation book, a legacy application, paper — and enters the same work into this system.

Yes, that is double entry, and yes it is tedious for a week. It is the only way to detect the
failure that actually matters, which is not a crash: **a wrong number nobody notices.** A crash
announces itself. A quotation total that is 200 birr out does not, and it is only visible against
a second source of truth.

Do not shorten this because the first three days went well. The interesting disagreements appear
when somebody does something unusual, and unusual things take a week to happen.

---

## 2. Accuracy — the metrics that decide the pilot

Compared **daily**, by a named person, from both systems.

| Metric | How to compare | Target |
|---|---|---|
| **Quotation total mismatch** | Every quotation issued that day: grand total in both systems | **0** |
| **Order value mismatch** | Every accepted order: agreed total in both | **0** |
| **Stock mismatch** | For tracked SKUs: on-hand, reserved, free | **0** |
| **Payment status mismatch** | Every payment: paid / part-paid / unpaid in both | **0** |
| **Receivable mismatch** | Outstanding balance per customer | **0** |
| **Duplicated or missing orders** | Order count and numbers in both | **0** |

**The target for every one of these is zero, not "small".** A one-birr difference is not a rounding
tolerance to accept; it is a defect to find, because money in this system is integer minor units
and cannot legitimately drift. A recurring mismatch of any size is a **P0**.

Record every mismatch in [`pilot-issue-template.md`](pilot-issue-template.md), including ones
that turn out to be the *old* system being wrong — which happens more often than people expect
and is one of the more valuable things a pilot produces.

### The daily reconciliation sheet

```
Date: ____________   Checked by: ____________

Quotations issued today        old: ____  new: ____   totals agree? Y / N
Orders accepted today          old: ____  new: ____   values agree?  Y / N
Payments confirmed today       old: ____  new: ____   agree?         Y / N
Outstanding receivables total  old: ____  new: ____   agree?         Y / N

Stock spot check (3 high-movement SKUs):
  SKU ______  on-hand old ____  new ____  counted ____
  SKU ______  on-hand old ____  new ____  counted ____
  SKU ______  on-hand old ____  new ____  counted ____

Mismatches found: ____   Logged as: ______________________
```

---

## 3. Stock safety

Compared daily against the distributor's existing source *and*, for selected high-movement
products, against a physical count.

Three figures, and they are different questions:

- **on-hand** — what is physically in the yard
- **reserved** — the portion committed to open orders
- **free** — on-hand minus reserved, what may still be promised

**Never correct a pilot discrepancy with a direct database update.** Use the Phase 7
reconciliation workflow: report the discrepancy, let it block what it blocks, resolve it through
the app. Two reasons, both important:

1. A manual update hides the fact that the system got something wrong, which is the single most
   valuable signal the pilot produces.
2. The reconciliation workflow is itself under test. If it is awkward or wrong, that needs to
   surface now rather than in month three.

---

## 4. Financial safety

**For the whole parallel period, this system is not evidence that a payment occurred.**

Finance continues their existing bank verification exactly as before. They check the bank, they
decide, and *then* they record that decision here. The application records a human confirmation;
it does not produce one, and nothing in it contacts a bank.

This is not a limitation to work around during the pilot — it is the design, and it stays true
afterwards. What the pilot is testing is whether the record of Finance's decision is accurate and
useful, not whether the software can replace Finance.

---

## 5. Efficiency

Secondary to accuracy, and worth measuring because it is the reason to adopt the system at all.

| Metric | How |
|---|---|
| Inquiry → quotation sent | Timestamps in the app, for quotations raised from an inquiry |
| Quote preparation time | Ask the salesperson to note it for five quotes a day, both ways |
| Follow-ups completed | The follow-up queue's completion rate |
| Payment verification time | Submitted → confirmed, from the payment record |
| Owner reporting time | How long the owner spends assembling "how did we do today", both ways |

Baseline the "old way" numbers **in the first two days**, before anybody has adapted. A comparison
against a half-remembered impression of how long things used to take is worthless.

---

## 6. Adoption

| Metric | How | Watch for |
|---|---|---|
| Users active by role | Sign-ins per role per day | A role that stops using it has hit something |
| Workflows completed unassisted | Count of assists per person per day | Should fall through the week |
| Support interventions | The issue log | Repeats on one screen are that screen's fault |

**A silent role is the loudest signal.** If the warehouse stops using the system on day three,
something happened on day three that nobody reported.

---

## 7. Business value

Only what can be counted honestly.

| Metric | How | Do not |
|---|---|---|
| Follow-ups that would have been missed | Overdue follow-ups the app surfaced that were not in the old process | Assume each becomes a sale |
| Overdue receivables surfaced | Overdue in the app that the distributor had not separately tracked | Claim they will now be collected |
| Retyping avoided | Count quotations produced from a parsed inquiry versus typed from scratch | Convert to a money figure |

**Do not fabricate ROI.** "The system surfaced 19 overdue follow-ups the owner did not know
about" is a fact worth reporting. "The system will increase revenue by 12%" is a number nobody
can support, and stating it damages every honest claim beside it.

---

## 8. What decides the outcome

At the end of the week:

**Continue** — zero accuracy mismatches unexplained, no P0, every role using it, efficiency at
worst neutral.

**Extend the parallel period** — mismatches found and explained but not yet re-verified, or a
role not yet using it properly. Extend by a week; do not switch over on a hope.

**Stop and fix** — any unexplained accuracy mismatch, any P0, or the distributor has lost
confidence in a number. Use the kill switch if writes are producing bad data, fix, re-verify from
a clean state, then restart the parallel period from day one.

**The decision belongs to the distributor's owner, not to whoever built the software.** Their
business is the one carrying the risk, and they are the one who has to trust the figures.
