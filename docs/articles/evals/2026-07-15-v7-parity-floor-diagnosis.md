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

## Strategic fork (for the operator)

The parity floors are **parse-tag byte parity** (`fold(actual) === fold(gold)`), a proxy the swap
gates inherited from plan 2. But the drop-in surfaces (`/v1/parse`, libpostal, nominatim) ultimately
serve a **geocode**, and on full addresses the neural model already matches the rules parser's
coordinate through the same resolver (`eval oa-resolver`: neural coord p50 6.3 km vs v0 6.0 km, p90
14.8 vs 15.0, within noise; the gap is region-match and the p99 tail). Many of the
parse-tag failures above (`Königsallee Düsseldorf` as one street span, `Korunní 8`/`10`) still resolve
to the correct place.

Three ways forward, in the author's recommended order:

1. **Re-gate the swap on coordinate parity, not parse-tag parity** (recommended). Measure whether the
   v1-rules→resolver and v264-neural→resolver coordinates agree on the drop-in traffic distribution.
   If they do, v7 unblocks now with no model campaign — the 0.90 parse-tag floor is over-strict for
   what production needs. **This is the decisive next experiment; it is not yet run — do not treat the
   coordinate-safety claim as proven.**
2. **#727 stage-2 (FSemi-CRF span head)** for the ~39% boundary class — the deepest lever, a
   multi-night arc, addresses the largest single context-invariant class. Stage-1 (aux head) plateaued
   at 5→2 flips, so this is the only remaining model lever for that class.
3. **Thin fragment fallback** — keep a narrow rules/structural fallback for the bare-autocomplete
   distribution the model plateaus on, ship v7 model-primary. Softens the "delete rules" goal but
   unblocks without a campaign.

A further 29M shard campaign (option 0, the default continuation) is **not** recommended as the lead:
the evidence says it re-plateaus.

## Reproduction

- `node mailwoman/out/cli.js eval parity --weights-cache scratchpad/v264-cache [--failing 50]`
- context probe / tokenizer probe / contextful-split scripts: `scratchpad/{ctx-probe2,tok-probe,parity-split}.mjs`
- v257 recipe: `corpus-python/src/mailwoman_train/configs/v2.5.7-fragment-v5-gentle-full.yaml`
