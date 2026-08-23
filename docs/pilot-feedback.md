# Pilot Feedback

Everything the distributor asks for during the pilot, captured and **not built yet**.

The discipline this file exists to enforce: **do not solve pilot feedback in advance, and do not
solve it during the pilot either.** A request made on day two is an impression; the same request
made by three people in week two is a finding. Building the first one wastes a week and
invalidates the comparison the pilot exists to produce.

Explicitly out of scope until a real pilot demonstrates the need: WhatsApp and other messaging,
Amharic beyond what exists, forecasting, procurement, route optimisation, and any dashboard
beyond the current one.

---

## How to classify

| | Means | What happens |
|---|---|---|
| **Blocking** | Real work cannot be done without it | Treat as P1: it is a defect wearing a feature request's clothes |
| **Frequent pain** | Possible, but hurts every day | Strong candidate for the next phase |
| **Convenience** | Would be nicer | Batch. Most of these stop being mentioned by week two |
| **Future** | A different product, or a later one | Record and move on |

**Count, do not just list.** One person asking for something is a preference. Four people asking
independently is a requirement. The tally column is what turns this file from a wish list into
evidence.

---

## Log

```markdown
### PF-0001 — <what they asked for, in their words>

Date:          2026-__-__
Asked by:      <name>, <role>
Heard:         1
Classification: <blocking | frequent-pain | convenience | future>

What they said:
  <their words, not a paraphrase — the wording usually contains the actual problem>

What they were trying to do:
  <the underlying task. Often different from the feature they asked for>

Existing way to do it:
  <if there is one — this is frequently the real answer, and means a training or labelling gap>

Decision:
  <defer to phase N | training | not doing, because ... | build now, because it is blocking>
```

---

## The question to ask every time

**"What were you trying to do when you wanted that?"**

People ask for solutions, not problems. Someone asking for a bulk-edit screen may be working
around a search that does not find what they need. Someone asking to export to Excel may not
trust a figure and want to check it by hand — which is a much more important thing to know.

The underlying task is what goes in the log. The requested feature is a clue.

---

## Requests already anticipated

Recorded here in advance so they are recognised as *expected* rather than treated as new
discoveries, and so nobody builds them reflexively mid-pilot.

| Likely request | Response during the pilot |
|---|---|
| "Send the quotation to the customer by WhatsApp" | Expected, and the single most likely one. It is real work: message templates, delivery, approval before anything leaves the building, and a customer-facing surface with none of the safeguards yet. **Log it.** |
| "Print / PDF the quotation" | Likely, and cheap. Still not during the pilot |
| "Amharic in more places" | Log which screens specifically. That list is worth more than a general request |
| "Tell me what to reorder" | Explicitly out of scope. The system shows what is below threshold; it does not know lead times, supplier prices or cash position |
| "Show profit on this order" | Cannot be answered honestly — there is no cost basis in the system. Say so plainly rather than approximating |
| "Let me edit a confirmed payment" | Will be asked after somebody makes a mistake. The answer is a correcting entry, and if that is awkward *that* is the thing to fix |
| "Fewer clicks to make a quotation" | Take seriously if it comes from daily use rather than first impressions |

---

## Weekly review

- **Anything classified blocking?** It is a P1. Move it out of this file.
- **What has been heard three or more times?** That is the next phase's shortlist.
- **What has stopped being mentioned?** People adapted. Do not build it.
- **What did nobody mention at all?** Quiet parts of the product are either perfect or unused, and
  the second is far more likely. Ask directly.
