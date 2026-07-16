# Is per-piece tagging worth its incoherence? — the B0 verdict

2026-07-16. Asked directly: does our intra-word emission incoherence vindicate or villainize the
architecture?

**Verdict: MIXED, and the mix is informative. The capability is real and provably beyond a word-unit
tagger's ceiling. We exercise it only when a partner word licenses it — which is the same defect,
for the third time, in a third component. The architecture is not the problem. The licence is.**

---

## The question, made decidable

A word-pooled tagger (subwords → one vector per word → one tag per word) **cannot** produce an
intra-word disagreement. We can, and do: on `Tindvegen nedre 44B` our model emits `B-house_number`
at 0.604 on the first digit piece and `I-postcode` at 0.587/0.765 on its continuations. Viterbi then
legally resolves to postcode, discarding the piece that was right.

That is a real liability. But the flexibility that lets us be wrong is the same flexibility that lets
us be right, so the question is not "is incoherence bad" — it is **whether the per-piece unit buys
more than it costs**. Two arms, one axis:

- **BENEFIT** — rows where the correct answer requires splitting _inside_ a whitespace word. Not in a
  word-unit tagger's output space at any confidence.
- **COST** — rows where our per-piece emissions disagree with themselves.

## The benefit arm: proven on one row, and one row is enough

```
Unit 12/345 Main St
  mailwoman  ->  unit "Unit 12", house_number "345", street "Main St"       CORRECT
  deepparse  ->  Unit "unit 12/345", StreetNumber "main", StreetName "st"   cannot represent it
```

`12/345` is one whitespace word carrying two components — unit 12 at number 345, the standard AU/NZ
form. Our parity gold has demanded this since the v1 rules era (`v1-address.aus-2`).

This is not deepparse scoring lower. **The correct answer is not in its output space.** One word gets
one tag; there is no assignment of tags-to-words that yields unit=12 _and_ house_number=345. No amount
of training or data fixes that — it is the unit of decision.

An existence proof needs one instance and it has one. The per-piece unit buys a class of answers a
word unit cannot express.

## The cost arm: 5 losses, of which only 3 are this defect

| input                        | mailwoman                                              | deepparse          |
| ---------------------------- | ------------------------------------------------------ | ------------------ |
| `Øvste Skogen 121`           | street ✓, **postcode 121** ✗                           | StreetNumber 121 ✓ |
| `aleja Wojska Polskiego 178` | street ✓, **postcode 178** ✗                           | StreetNumber 178 ✓ |
| `14 Glen Neaves`             | **postcode 14** ✗, street ✓                            | StreetNumber 14 ✓  |
| `Epleskogen 39A`             | **locality** "Epleskogen", postcode 39A                | StreetNumber 39a ✓ |
| `Tindvegen nedre 44B`        | **locality** "Tindvegen", street "nedre", postcode 44B | StreetNumber 44b ✓ |
| `Tindvegen 44B` _(control)_  | street ✓, house_number ✓                               | ✓                  |
| `Main St 44B` _(control)_    | street ✓, house_number ✓                               | ✓                  |

**The last two rows do the work.** `Tindvegen 44B` — an unfamiliar Norwegian street — parses
correctly. Add one word and `Tindvegen nedre 44B` breaks. So the cost arm is not "unfamiliar street
breaks the digit."

And the bottom two failures are **not digit ownership at all**: the model called the _street_ a
locality. That is Track A's bare-street polarity defect — the one v310 just fixed for French —
leaking in. With no street recognized, the digit has no street to attach to, so it cannot be a house
number. Only **3 of 5** cost rows are genuine digit ownership.

## The third instance of the licence

The benefit arm exposed something the cost arm hid. We split intra-word — but only when told to:

```
Unit 12/345 Main St  ->  unit "Unit 12", house_number "345"   SPLIT
     12/345 Main St  ->  house_number "12/345"                no split
Apt 12/345 Main St   ->  unit "Apt 12",  house_number "345"   SPLIT
     3/17 Bondi Rd   ->  house_number "3/17"                  no split
Unit 12/345          ->  unit "Unit 12", house_number "345"   SPLIT
     12/345          ->  postcode "12/345"                    no split, and postcode
```

The designator word licenses the split. Remove it and the identical characters collapse to one span.
Deepparse, for the record, splits neither — it cannot.

That is the same shape as the two defects already on the board:

| #   | licence                                                | consequence                   | status                            |
| --- | ------------------------------------------------------ | ----------------------------- | --------------------------------- |
| 1   | a **digit** licenses the _street_ reading              | `Rue Montmartre` → locality   | **fixed** by v310's shard (+50pp) |
| 2   | a **known street** licenses the _house_number_ reading | `Øvste Skogen 121` → postcode | open (Track B)                    |
| 3   | a **designator word** licenses the _intra-word split_  | `12/345` → one span           | open (this page)                  |

**One defect, three components: the model will not read a component without its co-occurring
partner.** It has learned the joint distribution and not the marginals. That is a training-data
property, not an architecture property — and instance 1 was fixed with a phenomenon shard plus a
counter-distribution, without touching the architecture at all.

## What this means for the architecture

**Vindicating:**

- The per-piece unit buys answers a word unit cannot represent, demonstrated (`Unit 12/345 Main St`).
- Our ≥4-digit boundary is _learned_, not structural: on the 351/376 parity rows we get right, the
  per-piece posterior tracks the length-conditioned corpus (2d continuation → postcode 0.0270 vs the
  corpus's 0.0427) and crosses over at 4 digits — the same boundary a word-unit tagger gets from its
  unit. We have it, from data. See [the H3 verdict](./2026-07-16-trackb-digit-ownership-h3-verdict.md).
- The incoherence is a **tail** (25/376), not the general behaviour of digit runs. "Every multi-piece
  digit run gets dragged to postcode by its continuations" is refuted at 0.0270.

**Villainizing, and worth saying plainly:**

- Their failure mode is bounded; ours is not. A word-unit tagger's worst case is a wrong tag. Ours is
  a _self-contradictory_ one, and Viterbi resolves it by discarding a first piece that was correct
  (0.604 `B-house_number`, outvoted 3-to-1 by its own continuations). We destroy information we
  already had.
- The `enforceWordConsistency` heal cannot reach this class, and the arithmetic says why: the vote
  sums softmax mass, and the continuations have more of it (postcode 1.53 vs house_number 0.65 on
  `▁3|9|A`). It works exactly as designed and still lands on postcode. Do not tune it for this.
- We collect the benefit only under licence. An unexercised capability is not a capability.

**Not settled here:** the arc's own research says a lower-fertility vocab is _upstream_ of any span
head, and the span head was built and closed first — a conditional verdict flagged on its parked PR.
Nothing on this page re-opens it. But note the direction: if the licence defect is a data property
and the shard fixes it, the vocab work is an optimization, not a prerequisite.

## Caveats

- The control set is 16 hand-built rows plus 6 minimal pairs. It is an **existence proof and a
  mechanism probe, not a score.** No CI is quoted and none should be.
- Three rows are marked `contested` (`Apt4B`, `1-2-3 Chome`, `Eberswalder Straße 100 104`) — each
  turns on a schema call we have not made — and are excluded from every count above.
- deepparse is good research and this is not a scoreboard. It ties us where the schemas overlap and
  beats us on one tag; the representational asymmetry runs both ways and this page is about ours.

## Reproduce

```bash
node scratchpad/intraword-mailwoman.run.ts
node scratchpad/mp-designator.mjs
cd /home/lab/Projects/deepparse && source .venv/bin/activate && \
  python /home/lab/Projects/mailwoman/scratchpad/intraword-deepparse.py
```
