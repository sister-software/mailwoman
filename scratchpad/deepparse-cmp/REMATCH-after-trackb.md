# The deepparse house_number rematch, re-read through Track B

2026-07-16 (afternoon). The `DEEPPARSE_HOUSE_NUMBER_BRIEF` control set, re-run on **shipped v6.4.0**
and current deepparse, then read through everything Track B established overnight.

**Verdict: deepparse's house_number lead is real but fully explained — it is coverage plus one
length-conditioned representation defect, not schema prior and not architectural magic. Both halves
are understood and scoped. And per-piece tagging buys us a class deepparse structurally cannot
represent. The brief's open questions are closed.**

---

## The control set, both parsers, v6.4.0

| input                             | mailwoman v6.4.0                     | deepparse                             | read                                                 |
| --------------------------------- | ------------------------------------ | ------------------------------------- | ---------------------------------------------------- |
| **bare fragments**                |                                      |                                       |                                                      |
| `39A` / `44B` / `121`             | postcode                             | StreetNumber                          | default choice on a bare token — see §1              |
| `9600`                            | postcode                             | PostalCode                            | tie                                                  |
| **valid postcode**                |                                      |                                       |                                                      |
| `1234AB` / `90210` / `75008`      | postcode ✓                           | PostalCode ✓                          | **tie**                                              |
| **invalid postcode** (Dutch rule) |                                      |                                       |                                                      |
| `1234SA` / `0123AB`               | postcode ✗                           | PostalCode ✗                          | **both fail identically** — neither encodes the rule |
| **route / date / name**           |                                      |                                       |                                                      |
| `Interstate 35`                   | locality + hn 35                     | StreetNumber 35 + street              | both imperfect (35 is a route number)                |
| `11 Novembre`                     | **postcode 11** + street             | StreetNumber 11 + street              | deepparse better                                     |
| `10 Ave`                          | hn 10 + Ave                          | StreetNumber 10 + ave                 | tie                                                  |
| **contextful**                    |                                      |                                       |                                                      |
| `Epleskogen 39A`                  | **locality** + postcode 39A          | StreetNumber 39a + street             | deepparse — but **NORWAY** (§2)                      |
| `Tindvegen nedre 44B`             | **locality** + street + postcode 44B | StreetNumber 44b + street             | deepparse — **NORWAY** (§2)                          |
| `aleja Wojska Polskiego 178`      | street ✓ + **postcode 178**          | StreetNumber 178 + street ✓           | deepparse — the digit defect (§3)                    |
| `9600 S Interstate 35 TX`         | **postcode 9600** + street + TX      | StreetNumber 9600 + **PostalCode 35** | both wrong, differently                              |

## §1 — the bare-fragment "loss" is a default, not an error

`39A` alone has no correct answer — it is the `postcode_only` query kind, genuinely ambiguous.
deepparse defaults short runs to StreetNumber; we default to postcode. For a geocoder a bare number
is most often a postcode lookup, so ours is defensible; theirs is more autocomplete-friendly. Not a
capability gap. (And in context our length gradient _is_ there — board 3 measured it crossing at 4
digits, deepparse's own boundary.)

## §2 — two of the four contextful losses — CORRECTED: the bare-street licence defect, NOT coverage

> **Correction 2026-07-16 (afternoon):** the coverage hypothesis below was FALSIFIED by the retrain
> (`NORWAY-RETRAIN-verdict.md`). v310 — zero Norwegian training — already parses _contextful_
> Norwegian perfectly (`Epleskogen 39A, 4370 Egersund` → street + house_number). v341 (8k, Norway
> un-dropped) is identical to v310 on every Norwegian row and on board 3. So these are NOT coverage;
> they are the bare-street polarity licence defect in bare form (§3's mechanism, cross-lingual). The
> original §2 text is kept below struck through for the record.

`Epleskogen 39A` and `Tindvegen nedre 44B` fail with the street read as a **locality** — B0's
signature of an _unseen_ street. And they are unseen: **v6.4.0 trained on exactly zero Norwegian rows**
(the YAML `NO:`→`false` bug, #1145 — 25k rows silently dropped since v1.9.0). deepparse trained on
Norwegian addresses; we accidentally didn't. This is coverage, fixed pending a Norway-inclusive
retrain — a clean one-variable experiment now that #1145 is on main.

## §3 — the one genuine model defect: length-conditioned digit ownership

`aleja Wojska Polskiego 178` is the tell: PL **is** in the corpus, the street parses **correctly**,
and the digit still goes to postcode. That is the cross-lingual, length-conditioned defect Track B
root-caused: the tokenizer has only 2 multi-digit pieces, so `178` → `[▁1,7,8]` with two
postcode-leaning continuations, and the model faithfully reproduces its corpus's
`P(I-pc | continuation)` prior (0.043 at 2 digits → 0.879 at 5). deepparse sidesteps it by tagging one
tag per _word_. This is the real target — B4b (a shard that dents it) or B4c (a number-piece vocab
splice that removes the continuations).

## §4 — the shared failures are nobody's edge

The Dutch invalid-postcode pairs (`1234SA`, `0123AB`) fail on **both** — neither system encodes the
`SS`/`SD`/`SA` exclusion or the 1000 floor. `9600 S Interstate 35 TX` is wrong on both (we say 9600 is
a postcode; they say 35 is). These are "nobody built it," not competitive gaps. Per the house rule,
the fix shape is a soft evidence channel, never a hard postcode validator — the first-piece
`B-house_number` is usually right.

## §5 — what per-piece tagging buys that deepparse cannot

The rematch is not one-directional. `Unit 12/345 Main St` → unit 12 + house_number 345 is **not in a
word-unit tagger's output space at any confidence** (B0) — deepparse returns `Unit "unit 12/345"`.
One word, two components. The flexibility that costs us the digit tail is the same flexibility that
wins a class they structurally can't reach.

## The brief's questions, closed

- **"Is the lead schema/field-order prior?"** No (H1 dead — deepparse tags bare `39A` as StreetNumber
  with no field context).
- **"Model knowledge or data-distribution?"** Both, split: coverage (Norway) + the length-conditioned
  representation defect. Not architectural superiority.
- **"Does deepparse encode the Dutch validity rule?"** No — it fails the same pairs we do.

## What this defines for the day

The visible gap decomposes into two fixes and two non-gaps:

1. ~~**Coverage — the Norway retrain.**~~ RUN AND FALSIFIED (2026-07-16): v341 ≡ v310 on every
   Norwegian row; v310 already generalizes to contextful Norwegian. Coverage is OFF the table — the
   Norwegian rows are the bare-street licence defect (§2 corrected). Data acquisition is breadth, not
   the house_number fix.
2. **The digit defect — B4b or B4c.** The PL-class rows. Shard (dents) vs number-piece vocab splice
   (removes the root). Operator's call on depth.
3. **Not chasing:** the Dutch validity rule and route-number disambiguation are shared gaps — soft
   channels if ever, never validators.
4. **Not abandoning:** per-piece tagging. It has a structural edge (§5) deepparse can't match.

deepparse remains good research; the honest read is that it ties us where the schemas overlap, wins
the house_number tag for two understood reasons, and loses the intra-word-split class by construction.

## Reproduce

```bash
node scratchpad/brief-control-mailwoman.run.ts
cd /home/lab/Projects/deepparse && source .venv/bin/activate && \
  python /home/lab/Projects/mailwoman/scratchpad/brief-control-deepparse.py
```
