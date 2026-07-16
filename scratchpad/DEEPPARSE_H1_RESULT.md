# H1 result + re-derivation — answering the v2 brief

2026-07-16. Returned in the brief's requested format. Written while the digit-ownership agent is
still cooking, so this deliberately stops short of proposing a fix.

> **READ `DEEPPARSE_ARCHITECTURE_COMPARISON.md` AFTER THIS ONE — it supersedes the "no mechanism
> found" conclusion below.** This page ends by saying the street token dominates but isn't a rule you
> can act on. That was true when written; a deeper architectural read then found the mechanism, and
> it is measured, not theorised: the model emits `B-house_number` on the FIRST piece of a digit run
> and `I-postcode` on its CONTINUATIONS. Everything downstream (Viterbi's legality mask, the
> word-consistency vote) then faithfully resolves the incoherence to postcode. The "Dead or
> lower-priority hypotheses" section here stays valid; the "Still open" framing does not.

## Verdict

**Task 1 (re-derive on current main): DONE. The brief's premise for it was wrong.** The inherited
comparison did NOT predate `ffcb8e96`. `git merge-base --is-ancestor ffcb8e96 0c4862e1` → true: the
query-shape prior was already in the tree when the dump ran (ffcb8e96 landed 01:56, the dump ran
05:39, and its config was copied from the post-fix `parity-corpus.ts`). Re-ran anyway — **both sides
are byte-identical** to the inherited dump. The mailwoman side was never starved. The numbers are
re-derived and citable; drop the caveat.

Corroboration that was sitting in the brief already: it re-measured `house_number 117/146 = 80.1%`,
which is exactly what the inherited harness reported. A starved config could not have matched.

**H1 (deepparse schema/field-order prior): DEAD.** Deepparse does not collapse on bare digit
fragments. It emits `StreetNumber` for `39A`, `44B`, `121` with **no street field present at all**.
Per the brief's own stop criterion, that rules out schema/field-order prior as the leading
explanation. **The lead is model knowledge.**

**What that knowledge is: a digit-run-length boundary at ≥4.** And we don't have one — we have a
constant function.

## The table (control set, both parsers)

| class                 | input                        | mailwoman            | deepparse                                |
| --------------------- | ---------------------------- | -------------------- | ---------------------------------------- |
| bare hn-like          | `39A`                        | pc=39A               | **hn=39a**                               |
| bare hn-like          | `44B`                        | pc=44B               | **hn=44b**                               |
| bare hn-like          | `121`                        | pc=121               | **hn=121**                               |
| bare hn-like          | `9600`                       | pc=9600              | pc=9600                                  |
| bare postcode valid   | `1234AB`                     | pc=1234AB            | pc=1234ab                                |
| bare postcode valid   | `90210`                      | pc=90210             | pc=90210                                 |
| bare postcode valid   | `75008`                      | pc=75008             | pc=75008                                 |
| bare postcode INVALID | `1234SA`                     | pc=1234SA            | pc=1234sa                                |
| bare postcode INVALID | `0123AB`                     | pc=0123AB            | pc=0123ab                                |
| route/date/name       | `Interstate 35`              | pc=35                | hn=35, st=interstate                     |
| route/date/name       | `FM 3009`                    | (nothing)            | pc=3009, Province=fm                     |
| route/date/name       | `11 Novembre`                | pc=11, st=Novembre   | hn=11, st=novembre                       |
| route/date/name       | `10 Ave`                     | hn=10, st=Ave        | hn=10, st=ave                            |
| contextful            | `Epleskogen 39A`             | pc=39A               | hn=39a, st=epleskogen                    |
| contextful            | `Tindvegen nedre 44B`        | pc=44B, st=nedre     | hn=44b, st=tindvegen nedre               |
| contextful            | `aleja Wojska Polskiego 178` | pc=178, st=aleja …   | hn=178, st=aleja wojska polskiego        |
| contextful            | `9600 S Interstate 35 TX`    | pc=9600, st=S Inter… | hn=9600, pc=35, st=s interstate, Prov=tx |
| contextful            | `1234AB, Amsterdam`          | pc=1234AB            | pc=1234ab, Municipality=amsterdam        |
| contextful            | `1234SA, Amsterdam`          | pc=1234SA            | pc=1234sa, Municipality=amsterdam        |

## The sharpest fact: 33/33

Swept digit-run length 1–6, bare and with a trailing letter, 3 values per cell:

```
                      mailwoman    deepparse
1 digit      7,3,9    postcode     house_number  (3/3)
2 digits     14,39,68 postcode     house_number  (3/3)
3 digits     121,…    postcode     house_number  (3/3)
4 digits     9600,…   postcode     postcode      (3/3)
5 digits     90210,…  postcode     postcode      (3/3)
6 digits     123456,… postcode     postcode      (3/3)
1digit+ltr   7A,3B,9C postcode     house_number  (3/3)
2digit+ltr   39A,44B  postcode     house_number  (3/3)
3digit+ltr   121A,…   postcode     house_number  (3/3)
4digit+ltr   9600A,…  postcode     postcode      (3/3)
4digit+2ltr  1234AB,… postcode     postcode      (3/3)

mailwoman distinct tags across 33 fragments: ['postcode']
deepparse distinct tags across 33 fragments: ['house_number', 'postcode']
```

Deepparse's boundary is at digit-run length **≥4**, 100% consistent, zero exceptions. Ours does not
exist: `7` is a postcode, `123456` is a postcode, `9C` is a postcode.

This single boundary explains **every** row in the brief's mechanism list — `39A`, `44B`, `121`,
`178`, `14` are all ≤3 digits. It also explains the 1/16 deepparse misses: `9600` is 4 digits, so
its prior calls it a postcode too. Deepparse recovers it from context (`9600 S Interstate 35 TX` →
hn=9600); we never do.

## Refinement: this is digit ownership, not street segmentation

On `aleja Wojska Polskiego 178` we segment the street **correctly** and then hand the trailing digit
to postcode. Track A's segmentation is doing its job on that row. The defect is purely the ownership
decision, which supports the brief's Track A / Track B split.

## Hypotheses I killed (don't re-run)

**Class weights — DEAD.** `house_number` and `postcode` carry **identical** weights (B/I = 1.5 each)
in v264's `config.json`. There is no upweighting to explain a postcode preference.

**H6, position (leading vs trailing) — DEAD, my hypothesis, wrong.** `10 Ave` → hn but
`Epleskogen 39A` → pc suggested the digit's position decided it. Minimal pairs refute it: `14 Main St`
→ hn AND `Main St 14` → hn; `14 Epleskogen` → **pc** but `Epleskogen 14` → **hn** (the opposite
direction). Position is not the variable.

**H6b, street-suffix presence — WEAK, 2/6, not a mechanism.** Bolting `St` onto the unrecognized token
rescued house_number in only 2 of 6 pairs (`Epleskogen St 39A` ✓, `Genter St 16a` ✓; the other four
unmoved).

**What the H6 sweep DOES show, without giving a rule:** the accompanying street token dominates.
Recognized streets (`Main St`, `Broad St`) → house_number **14/16**. Unrecognized (`Epleskogen`,
`Kájovská`) → **1/16**. But it's lexically unstable rather than rule-governed: `Tindvegen 44B` → hn
while `Tindvegen nedre 44B` → pc. Adding a word broke it. Treat this as evidence the digit decision
is entangled with street-token familiarity, not as a mechanism you can act on.

## On H3 (the corpus-prior count) — a definition warning

I did not re-run H3 on the full Modal corpus (left for whoever wants it). But before someone does:
**the local count and the bare sweep may not be measuring the same thing.** `P(house_number | bare
digit) = 0.810` counts digit tokens _in context_ across addresses. The bare sweep asks what the model
does when the digit is the _entire input_, which is the `postcode_only` query kind — a real class in
`kind-classifier`, and one the corpus genuinely does contain as whole-input examples. A corpus with
many bare-postcode inputs and ~zero bare-house-number inputs would teach "digit alone → postcode"
_correctly_, and the bare sweep would not contradict the corpus at all.

That does not rescue us: the **failing parity rows are contextful** (`Epleskogen 39A`,
`aleja Wojska Polskiego 178`), and we say postcode there too. If you re-run H3, count contextful
trailing digits separately from whole-input digits, or the two numbers will look like a contradiction
that isn't one.

## Commands run

```bash
git merge-base --is-ancestor ffcb8e96 0c4862e1        # re-derivation premise check
node scratchpad/deepparse-dump-mailwoman.run.ts       # byte-identical to inherited
python scratchpad/deepparse-dump.py                   # (deepparse venv) byte-identical
python3 scratchpad/deepparse-score.py                 # numbers unchanged
node scratchpad/h1-control-mailwoman.run.ts
python scratchpad/h1-control-deepparse.py             # (deepparse venv) H1 + joint table
node scratchpad/h1-shape-sweep.run.ts                 # 33/33 postcode
python scratchpad/h1-shape-sweep-dp.py                # (deepparse venv) the >=4 boundary
node scratchpad/h6-position-shape.run.ts              # position refuted
node scratchpad/h6b-suffix-trigger.run.ts             # suffix 2/6
```

## Raw output paths

- `scratchpad/deepparse-cmp/h1-joint.json` — control set, both parsers, ordered spans
- `scratchpad/deepparse-cmp/h1-shape-sweep.json` — mailwoman, 33 fragments
- `scratchpad/deepparse-cmp/h1-shape-sweep-joint.json` — both parsers, 33 fragments
- `scratchpad/deepparse-cmp/h6-position-shape.json` — position minimal pairs

## Changed files

None in `mailwoman/`, `core/`, or `corpus-python/`. Probes are scratchpad-only. No source touched.

## Postcode validity: neither system has it

Both parsers call `1234SA` and `0123AB` postal codes. Per the brief's own criterion, that settles it:
**neither encodes the Dutch rule**, and the `nld-20/21/22` minimal pairs are testing something nobody
built. Deepparse doesn't have the answer to steal here.
