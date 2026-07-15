# 2026-07-15 — The v7 parity-floor blocker: what it is

**TL;DR.** The v7 rules-excision arc is blocked on the neural model clearing the pre-registered
swap floors on the rescued parity corpus (street ≥0.90, house_number ≥0.97). The just-shipped
**v264** (6.3.0) sits at **street 0.543, hn 0.767, postcode 0.986** — the same place v257 sat one
country-channel and one span-head ago. This note is the diagnosis behind that number: what the
failures _are_, why more of the v250→v257 shard campaign is unlikely to move it, and the strategic
fork that follows.

## Measurement

Package-shaped grade (`eval parity --weights-cache`, the #718-safe path), v264 = the shipped model:

| floor           |  v264 | v257 (8k gentle) | floor bar | verdict |
| --------------- | ----: | ---------------: | --------: | ------- |
| street (family) | 0.543 |            0.536 |      0.90 | FAIL    |
| house_number    | 0.767 |            0.767 |      0.97 | FAIL    |
| postcode        | 0.986 |            0.986 |      0.97 | PASS    |

v264 is a hair **better** than v257 on street (0.543 vs 0.536) and identical on hn/postcode, so the
v261 span-boundary head and the v263/v264 country channel did **not** erode fragment parsing. The
plateau is old: v255 peaked at street 0.596 @ 2k but was unstable (the bare-locality↔US-admin
treadmill, #1102), and v257's gentle 8k traded that peak for a stable 0.536. Nothing since has moved
it.

## What the failures are (85-row sample, `--failing 50` over the three floors)

| class                                  | share | context-invariant? | example                                                    |
| -------------------------------------- | ----: | ------------------ | ---------------------------------------------------------- |
| **empty** (tag not emitted)            |   40% | —                  | `Epleskogen 39A` → hn `""`; `9600 Interstate 35` → hn `""` |
| **boundary-digit** (#727)              |   20% | **yes**            | `Korunní 810` → hn `10` (the `8` leaked into street)       |
| **boundary-span** (#727 + prefix-drop) |   19% | **yes**            | `Rue Saint Anne` → street `Anne`; `Korunní` → `Korunní 8`  |
| **accent-mangle**                      |   15% | partly             | `Rua Raul Leite Magalhães` → `…Magalh es`                  |
| **unit**                               |    4% | —                  | `U12/345` → `U12/345` (gold hn `345`)                      |

Two structural findings under this:

**1. The tokenizer covers the diacritics but over-fragments the words.** Probing the SP v0.9.0
tokenizer: `á ã ó ß Å` are all single covered pieces (only RO `ț` byte-falls-back). But diacritic
words shatter — `Kájovská` → `▁K á j ovská`, `Magalhães` → `▁Mag al h ã es`. The heavy sub-word
fragmentation, not byte-fallback, is what corrupts the span surface when the model tags some pieces
and drops others. This is a tokenizer _granularity_ gap for CZ/PT/PL/RO (the FR/Nordic splices didn't
reach them), not a coverage gap.

**2. Context fixes the coverage class but NOT the boundary class.** Re-parsing the failing bare
forms with full address context:

| input (bare → +context)                      | bare result               | +context result                  |
| -------------------------------------------- | ------------------------- | -------------------------------- |
| `Epleskogen 39A` → `…, Oslo, Norway`         | locality+postcode (wrong) | **street+hn 39A ✓**              |
| `9600 Interstate 35 TX` → `…, Austin, TX`    | postcode `9600` (wrong)   | **hn 9600 ✓**                    |
| `aleja Wojska Polskiego 178` → `…, Warszawa` | postcode `178` (wrong)    | **hn 178 ✓**                     |
| `Korunní 810` → `…, Praha, Czechia`          | `Korunní 8` / `10`        | `Korunní 8` / `10` (still wrong) |
| `Genter Straße 16a` → `…, Munich`            | `…16` / `a`               | `…16` / `a` (still wrong)        |

The "empty/coverage" class (40%) is a **bare-fragment distribution** effect: with full context the
model parses it correctly, and the rules parser was purpose-built for the bare-autocomplete
distribution. The "boundary" class (39%) is **#727**. It persists with full context because it is a
decode-segmentation error at the street↔house_number boundary, not a missing-context error.

## Why "more shard" is unlikely to break the plateau

The v257 recipe **already** carries targeted bare-street shards at the campaign's highest source
weight (12.0): `synth-no-street-led`, `synth-cz-pcfirst-preposition`, `synth-fr-bare-street`,
`synth-si-bare-village`, plus `synth-fragment` at 6.0. Heavy targeted data on the exact locales that
still fail, and it plateaued at 0.54. The bare-fragment mis-segmentation and the #727 boundary class
both survived a seven-run campaign (v250→v257) that ended on a documented capacity/stability treadmill
(#1102). **Street 0.90 parse-tag parity is probably not reachable at 29M on this fragment-heavy
distribution.**

## Contextful vs bare: the gap holds in both subsets

Splitting the 321 live fixtures by whether the gold carries admin context (locality/region/country):

| subset     |   n | street | house_number | postcode |
| ---------- | --: | -----: | -----------: | -------: |
| contextful | 192 |  0.514 |        0.778 |    0.971 |
| bare       | 129 |  0.580 |        0.754 |    1.000 |

Street fails ~0.5 on **both**; the contextful subset is not meaningfully better. The gap is a
pervasive street-parsing quality problem (boundary-absorption, FR/Romance street-type-prefix drop,
accent, city-absorption) that holds whether or not the input carries admin context. It would not
vanish on production traffic.

## Coordinate parity — measured

The swap gates use **parse-tag byte parity** (`fold(actual) === fold(gold)`), a proxy inherited from
plan 2. The drop-in surfaces serve a **geocode**, so the question that matters for the swap is whether
the neural parse resolves to the same place as the rules parse. Measured over the 321 live fixtures,
each resolved through the same WOF resolver with both the rules tree and the v264 tree
(`scratchpad/coord-parity.mjs`):

| subset                  | both resolved | within 1 km | within 25 km | median Δ | p90 Δ   |
| ----------------------- | ------------: | ----------: | -----------: | -------: | ------- |
| all both-resolved       |           164 |       76.8% |        78.7% |   0.0 km | 384 km  |
| neural street tags PASS |            74 |       98.6% |        ~100% |   0.0 km | 0.0 km  |
| neural street tags FAIL |            45 |       53.3% |        60.0% |   0.0 km | 1631 km |

(135 of the 321 resolve under neither parser — bare street fragments with no admin anchor to geocode
to, so they cannot move the swap either way.)

The signal is two-sided:

- **When the neural street parse is correct, the geocode is coordinate-safe**: 98.6% within 1 km of
  the rules geocode, median 0 km. The parse-tag failures that are benign boundary/assembly differences
  (`Königsallee Düsseldorf` tagged as one street span) resolve to the same place.
- **When the neural parse fails, a tail diverges hard**: 40% of the street-failing subset move >25 km,
  often to a garbage geocode — `1210a IA 10 W IA` → American Samoa (10,053 km), `California` →
  Maryland, `Texas 76013` → Michigan, bare `6000, NSW, Australia` → the AU country centroid. These are
  the bare-fragment / US-highway / bare-state-name classes.

A **pure** coordinate re-gate does not hold: it ships that tail. The tail lands on input classes the
pipeline can already detect, which is what the recommended path below exploits.

Caveats: this measures neural-vs-rules divergence, not accuracy against ground truth (the corpus has
no gold coords, and the rules parser is sometimes the wrong one); and the corpus is deliberately
fragment/edge-case-heavy, so the >25 km tail is smaller on real drop-in traffic than the 21% here.

## Recommended path: neural-primary with a bounded fallback

The garbage-geocode tail concentrates on classes the runtime pipeline already separates. Three
components bound it, in priority order:

1. **Route on kind.** The pipeline classifies input kind at stage 2.5 (`@mailwoman/kind-classifier`:
   `structured_address` / `postcode_only` / `intersection` / …). Gate the swap so `structured_address`
   uses the neural parser (coordinate-safe per the table above) and the bare-fragment kinds keep the
   rules/structural fallback until the model clears them.
2. **Plausibility guard on the resolution.** Fall back when the neural resolution is implausible for
   the input's country signal — a country-centroid hit, or a cross-country jump like `California` →
   Maryland. A cheap post-resolve check, no model change.
3. **Ship v7 on this hybrid gate**, not the 0.90 parse-tag floor. The swap is neural-primary; the
   fallback shrinks as the model improves and is deleted when it stops firing.

**Measured** (`scratchpad/coord-parity.mjs`, extended with the kind-classifier + both guards). The
18-fixture garbage tail breaks down: the kind-router catches 11 (non-structured kinds → rules
fallback), and of the 7 that classify as `structured_address`, the plausibility guard catches 4
(country-centroid hit or out-of-country coord). Together they bound the tail from 18 to **3 of 321
live fixtures (0.9%)**, at a cost of **zero false-positive fallbacks** — none of the 81 coordinate-safe
structured fixtures trip either guard. The surviving 3 are structured, in-country, wrong-locality
neural resolutions, and their archetype is the #727 boundary class (`Korunní 810, Praha` → wrong
Czech city). So the hybrid gate ships **paired with** #727 stage-2, which erases that residual, not as
a permanent substitute for the model work.

This unblocks v7 without a model campaign that re-plateaus and without shipping the tail a pure
coordinate re-gate would. **#727 stage-2 (FSemi-CRF span head)** stays the model lever for the ~39%
boundary class and shrinks the fallback further. A **29M shard campaign is not recommended as the
lead**: the plateau evidence says it re-plateaus.

## Reproduction

- `node mailwoman/out/cli.js eval parity --weights-cache scratchpad/v264-cache [--failing 50]`
- context probe / tokenizer probe / contextful-split scripts: `scratchpad/{ctx-probe2,tok-probe,parity-split}.mjs`
- coordinate parity + kind-router + guards: `scratchpad/coord-parity.mjs` (resolve each fixture through
  both parsers, compare coords, cross-tab the tail against the kind-classifier + plausibility guards)
- v257 recipe: `corpus-python/src/mailwoman_train/configs/v2.5.7-fragment-v5-gentle-full.yaml`

The guard measurement's tail (n=18) is small, so the 11/7 and 4/3 splits are noisy; and it grades
neural-vs-rules divergence, not ground-truth accuracy. Treat the 0.9% residual as an order-of-magnitude
result — the tail is bounded to low single digits, not that it is exactly three.
