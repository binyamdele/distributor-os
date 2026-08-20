# Validation Scorecard — Build / Pivot / Kill

The hypothesis under test:

> A medium-sized construction-material distributor in Addis Ababa will pay to reduce the manual
> work between a customer inquiry and a fulfilled order.

These criteria are **hypotheses, not immutable facts**. They are written down in advance so that
the decision is made against a standard set before the evidence arrived, rather than against
whatever the evidence happens to support afterwards.

---

## Sample

Target: **10 interviewed distributors**, medium-sized, Addis Ababa, construction materials.

Interviews follow `customer-discovery.md`. An interview only counts toward the sample if it
included someone who either prepares quotations or owns the business.

---

## Decision criteria

### BUILD

All three must hold:

- **≥ 6 of 10** interviewed distributors report serious pain in the **same** workflow —
  not merely "pain somewhere in sales"
- **≥ 3** agree to pilot
- **≥ 1** agrees to pay

### PIVOT

- Strong, consistent pain exists, but concentrated in a **different** workflow than
  inquiry-to-quotation — for example collections, stock visibility, or delivery coordination.

Pivot means re-pointing the same governance architecture at that workflow. It does not mean
building both.

### KILL

Any of:

- Pain is weak, or highly varied across distributors with no common shape
- Existing tools — including spreadsheets and WhatsApp — solve it adequately in practice
- Businesses acknowledge the improvement but do not value it enough to pay for it

---

## Interpreting the signals honestly

The criteria above are easy to satisfy accidentally. These rules make that harder:

- **"Serious pain in the same workflow"** means the pain was described *unprompted*, in
  concrete terms, with a number attached. Agreement with a description you supplied does not
  count toward the six.
- **"Agrees to pilot"** means they named a person who would use it and a week when they could
  start. Enthusiasm without a name and a date is not a pilot.
- **"Agrees to pay"** means a number was said out loud by someone who can approve spending. A
  willingness to pay "if it works" is not a yes; it is a request for a free trial.
- **A single very enthusiastic distributor is not a signal.** It is a design partner, which is
  useful, and a market of one, which is not.

---

## Recording the evidence

| # | Company | Pain workflow | Unprompted? | Existing tool | Pilot? | Pay? | Notes |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |
| 7 | | | | | | | |
| 8 | | | | | | | |
| 9 | | | | | | | |
| 10 | | | | | | | |

**Tally:** same-workflow serious pain __ / 10 · pilots __ · paying __

**Decision:** BUILD / PIVOT / KILL — dated, with the reasoning written below it.

---

## Product-side success criteria, once piloting

Distinct from the market decision above. Once a pilot is running, the MVP is working if:

- Time from inquiry received to quotation sent falls measurably against the distributor's own
  stated baseline
- Salespeople accept most AI-parsed lines without editing them, and the rejection rate is
  visible rather than assumed
- Follow-up completion rate rises against the baseline of "we follow up when we remember"
- Finance confirms payments faster, and no order is ever released without a human confirmation
- The owner reads the daily brief more than once a week without being asked to

The corresponding instrumentation is listed in the success-metrics section of the brief and is
built in from day one. If a metric cannot be measured, its criterion above is not evidence.

---

## Standing risk to this scorecard

The most likely way this exercise fails is not a wrong answer — it is a soft one: ten polite
interviews producing ten "yes, that would be useful", zero pilots, and a decision to build
anyway. If the tally is ambiguous, that is a KILL-leaning result, not a BUILD-leaning one.
