# Pilot Severity and Escalation

What counts as an emergency, who does what, and when to stop.

Severity is decided by **what the defect does to the distributor's business**, never by how hard
it looks to fix. A one-character label change that makes Finance confirm the wrong payment is a
P0; a crash on a screen nobody uses is a P2.

---

## P0 — stop the pilot

**Anything that has produced, or could produce, false business truth.**

- a cross-tenant leak — one organization seeing another's data in any form
- wrong payment truth — a payment shown as confirmed that was not, or the reverse
- stock consumed twice, or consumed without goods leaving
- an incorrect monetary total anywhere: quotation, order, payment, receivable
- data loss that a restore cannot recover
- an authorization bypass — anyone doing something their role forbids

### What to do, in order

1. **Throw the kill switch immediately.**
   ```bash
   pnpm ops:maintenance --on --reason "P0: <what is wrong>"
   ```
   Writes stop, reads keep working, nothing is deleted. Do this *before* investigating —
   investigation takes time, and every minute the system keeps writing is more bad data.

2. **Back up.** The damaged state is evidence.
   ```bash
   pnpm ops:backup --label "p0-$(date -u +%Y%m%dT%H%M)"
   ```

3. **Tell the distributor's owner.** Directly, in person or by phone. Not a message that waits.

4. **Establish blast radius.** Which records, which customers, which money. The audit log answers
   most of this; the correlation id in any error report answers the rest.

5. **Fix, with a test that would have caught it.** A P0 fixed without a regression test is a P0
   that recurs.

6. **Re-verify from a known-good state**, then restart the parallel period from day one. Not from
   where it left off — the point of the parallel week is a continuous clean comparison.

**Do not lift the kill switch to "let them keep working while we look".** Processing more money
and stock through a system known to be wrong is how a bug becomes a dispute.

---

## P1 — workflow blocked

**Real work cannot be completed, but nothing false has been recorded.**

- a user cannot finish a core flow: inquiry → quotation → order → payment → delivery
- a permission blocking valid work for the role that should have it
- the application unreachable, or readiness failing
- evidence cannot be uploaded or read

**Response: same day.** No kill switch — the system is not producing wrong data, it is refusing
to produce right data. Record the workaround people are using, because it tells you what the
screen should have done.

---

## P2 — workaround exists

Work is possible but slower or clumsier: an awkward screen, a confusing label, an extra step, a
missing filter.

**Response: batch weekly.** Resist fixing these mid-pilot. Each change invalidates a little of
what has already been observed, and most P2s reported on day two stop being reported by day five
because people learned the screen.

---

## P3 — usability and cosmetic

Wording, layout, spelling, ordering, colour.

**Response: log and defer.** Collect them in [`pilot-feedback.md`](pilot-feedback.md). They are
worth fixing, and they are worth fixing *after* the pilot has answered the question it exists to
answer.

---

## Escalation

| Severity | Who is told | How fast | Who decides |
|---|---|---|---|
| **P0** | Owner + engineer, immediately | Now | Owner decides whether the pilot continues |
| **P1** | Engineer, and owner if it lasts past a day | Same day | Engineer |
| **P2** | Logged | Weekly review | Engineer |
| **P3** | Logged | After the pilot | Engineer |

**One named person carries the phone.** Not a rota, not a group chat — one person the distributor
can ring. Write their name and number at the top of the issue log before the pilot starts.

---

## The "works as designed" trap

Several correct behaviours in this system are genuinely surprising, and each will be reported as
a bug at least once:

| Reported as | Actually |
|---|---|
| "Completed order still shows as owing money" | Correct. A delivered credit order is finished operationally and owes its balance. Completion is about goods, not money |
| "Stock did not change when we marked it prepared" | Correct. Picked goods are still in the yard. Stock moves when they leave |
| "The failed delivery did not put the stock back" | Correct. The goods are somewhere between the yard and the customer. A return is a separate counted event |
| "It says 'none decided' instead of 0%" | Correct. Nothing was accepted or rejected today, which is not the same as losing everything |
| "I cannot edit a confirmed payment" | Correct, and enforced by the database. A correction is a second recorded fact |

**Classify these as `training`, not as `works as designed`.** The behaviour is right, so something
else is wrong — the label, the tooltip, or what people were told. Two reports on the same point
means the explanation is not reachable where the confusion happens, and *that* is a defect worth
fixing.

Using "works as designed" to close a report without changing anything is how a team stops
learning from its users.
