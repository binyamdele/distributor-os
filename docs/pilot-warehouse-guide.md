# Warehouse — Quick Guide

## What you do

Pick what has been sold, hand it over, and keep the recorded stock honest.

## What you cannot do, and why

| | Why |
|---|---|
| See prices or payment evidence | You need a SKU, a unit and a quantity. A customer's bank slip is nobody's business in a yard |
| Send an order to the warehouse yourself | Only an order that has cleared its payment gate appears at all |
| Say a delivery arrived | You hand goods over; whoever drove says whether they arrived. One person doing both could close an order alone |
| Decide whose order loses stock when there is not enough | That is a commercial decision with a customer on the other end. You establish what is physically there |

## Your day

**1. Prepare Today.** Everything here has already cleared its payment gate. If an order is not
here, it is not ready — do not go looking for it.

**2. Start preparation.** Records that you have it.

**3. Pick each line.** Mark it picked only when it is picked, in full. There is no "8 of 12": a
line that cannot be picked completely leaves the task unfinished, which is correct.

**4. Mark prepared.** The goods are by the door. **Nothing has left inventory yet** — the system
still counts them as in the yard, because they are.

**5. Complete handoff.** **This is the moment stock leaves.** The quantity comes off the shelf
figure, the reservation closes, and it cannot be undone. Only press it when the goods are actually
leaving your custody.

**6. Then either** a delivery is created (someone else drives it) **or** you record a collection
if the customer is taking it themselves.

## When completion is blocked

You will see something like:

> Rebar 12mm — required 80, actively reserved 60

The system and the yard disagree, and it will not ship until somebody looks. **This is working
correctly.** Press **Report inventory discrepancy**, enter what you actually counted, and add a
note.

Then it goes to a manager. You establish the physical truth; they decide the commercial
consequence. Do not adjust stock to make the block go away — that is the one action that would
hide the problem instead of fixing it.

## Returns

When goods come back:

1. **Receive** — they are physically in the yard
2. **Inspect** — count them into sellable and damaged
3. **Complete** — only the sellable quantity goes back on the shelf

Damaged units stay out of stock and stay in the record. Nothing disappears: 80 left, 76 came back
sellable, 4 came back broken, and all 80 are accounted for.

## Stock adjustments

For a count correction — breakage, a miscount found during a stocktake, goods received.

**Always say why in the reason.** In six months, "why did cement drop by 40" has to have an
answer, and the reason field is the answer.

An adjustment is a *different event* from shipping goods. Never use one to make a blocked handoff
proceed.

## Never work around these

- **Do not mark a line picked before picking it.** The next person believes you.
- **Do not complete a handoff before the goods leave.** The count will be wrong from that moment.
- **Do not adjust stock to clear a discrepancy block.** Report it. That is what it is for.
- **Do not restock a failed delivery yourself.** The goods are out there somewhere; a return is a
  counted event with its own record.
