# Pilot Issue Log

Copy the template below for each issue. Keep them in one file or one folder — what matters is that
they are together and searchable, because the value is in the pattern rather than any single
entry.

**The most important field is the last one.** A product defect and a training gap look identical
when they are reported and need completely different responses. Guessing wrong means either
shipping code to fix a misunderstanding, or telling somebody to try harder at something that is
genuinely broken.

---

## Template

```markdown
### PILOT-0001 — <one line, what the user experienced>

Date:            2026-08-24
Reported by:     <name>, <role>
Reference:       req_XXXXXXXXXX          # from the error screen, if there was one
Workflow:        <inquiry | quotation | order | payment | warehouse | delivery | return | dashboard>
Severity:        <blocking | painful | annoying | cosmetic>

Expected:
  <what the user thought would happen, in their words>

Actual:
  <what happened>

Steps:
  1.
  2.
  3.

Workaround:
  <what they did instead, or "none — they stopped">

Classification:  <product defect | training | process | data | environment | works as designed>

Resolution:
  <what was done, and when>
```

---

## Severity

| | Meaning | Response |
|---|---|---|
| **Blocking** | Cannot complete a real customer transaction | Same day |
| **Painful** | Possible, but slow or requires a workaround | Same week |
| **Annoying** | Works, but wrong or confusing | Next batch |
| **Cosmetic** | Wording, layout, spelling | When convenient |

Severity is **the user's experience**, not the engineering difficulty. A one-character label fix
that makes Finance confirm the wrong payment is blocking.

These four words describe how much an issue hurts to work with.
[`pilot-severity-policy.md`](pilot-severity-policy.md) has a separate P0–P3 scale that decides
*who is woken and whether the pilot stops*, and the two are not the same question:

| Here | There | The difference |
|---|---|---|
| — | **P0** | Something false was recorded: wrong money, wrong stock, a cross-tenant leak. **Throw the kill switch.** An issue can be P0 while nobody found it annoying at all — that is exactly what makes it P0 |
| Blocking | **P1** | Real work cannot be completed, but nothing false was recorded |
| Painful | **P2** | A workaround exists |
| Annoying / Cosmetic | **P3** | Log and defer |

**A P0 is not a severe version of "blocking".** Blocking means somebody is stuck and knows it. P0
means a number in the system is wrong and nobody may have noticed — which is the failure this
whole pilot exists to detect.

---

## Classification

| | Means | Response |
|---|---|---|
| **Product defect** | The software is wrong | Fix it, with a test that would have caught it |
| **Training** | The software is right; the person did not know | Update the role guide. Two of these on the same point is a product problem wearing a training costume |
| **Process** | The distributor's own process does not fit | Discuss. Sometimes their process is right and the software should change |
| **Data** | Bad import or bad setup | Fix the data, and ask why validation let it through |
| **Environment** | Network, browser, phone | Note it; watch for a pattern |
| **Works as designed** | Behaving correctly and surprising anyway | **Look hard at this one** — see below |

### On "works as designed"

This is the most dangerous label in the list. Used honestly it records a deliberate decision. Used
lazily it becomes a way to close reports without thinking.

Some behaviour in this product is genuinely correct and genuinely surprising, and every instance
should be checked against whether the *explanation* is reachable from the screen:

- a completed order that still owes money (delivered credit order)
- stock not moving when the warehouse marks an order prepared
- a failed delivery not returning goods to stock
- an acceptance rate showing "none decided" rather than 0%
- a confirmed payment that cannot be edited

If a user hits one of these, the behaviour is right and something else is wrong — the label, the
tooltip, or the training. Record it as **training** and fix the explanation.

---

## What to review weekly

- **Blocking issues still open.** There should be none by Friday.
- **Repeats.** The same report from three people is a design problem, not three users.
- **The training pile.** Repeated confusion about one screen is that screen's fault.
- **Anything filed "works as designed".** Is the explanation reachable where the confusion happens?
- **What nobody reported.** Quiet parts of the product are either perfect or unused, and the second
  is far more likely.

---

## Example

```markdown
### PILOT-0007 — Finance says the dashboard "still shows an order we delivered as owing money"

Date:            2026-09-02
Reported by:     Yonas, Finance
Reference:       —
Workflow:        dashboard
Severity:        annoying

Expected:
  Once the warehouse delivers an order, it should stop appearing in receivables.

Actual:
  SO-000412 shows as Completed and still appears under overdue receivables for ETB 180,000.

Steps:
  1. Open the dashboard as Finance
  2. Overdue receivables shows SO-000412
  3. Open the order — status Completed

Workaround:
  None needed; nothing is actually wrong.

Classification:  training

Resolution:
  Behaving correctly. SO-000412 is a 30-day credit order: it was delivered, so it is
  operationally complete, and the customer has not paid, so it is still owed. Completion is
  about goods; payment is separate. Coupling them would mean delivering an order erased the
  debt.

  Third report of this. The behaviour stays; the explanation was not reachable from the
  dashboard, so a note was added to the receivables panel and to the owner and finance guides.
```
