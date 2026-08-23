# v5.0.0 — the from-scratch base that passed the gate and failed the board

**Verdict: HOLD.** Not published. The model clears the promotion gate 18/18 and is blocked by iron
rule 6 on the 649-row board.

## What was run

A from-scratch 60,000-step run, seed 42, no `init_from`, no EWC — the shape the `training-arc` skill
asks to be stated rather than inherited. Corpus `v0.27.0-house-venue-intl`, `country_weights` widened
from the shipped 25 countries to 134.

| artifact          | value                                                          |
| ----------------- | -------------------------------------------------------------- |
| fp32              | 157.1 MB, md5 `ba611afd6ca37009eecdc661c0628fd3`               |
| int8              | 39.4 MB, md5 `5f34dda7f8881d9f379adb522f6aeb99`                |
| tokenizer         | `5c01cdcd4ae25849c5cb26b69fd3dde9` — byte-identical to shipped |
| shipped comparand | `98a49b5ca2948cdbe1dd981d60ef637d` (v4.4.0 step-60000 int8)    |

The tokenizer identity was checked, not assumed. A from-scratch run is exactly where a tokenizer
change hides, and F1 is not comparable across tokenizer versions — had these differed, both the
staging and the comparison would have been invalid while still producing numbers.

## The board

```
leg                                  improved  regressed  net  differed
self-control (shipped vs itself)            0          0    0     0/649
candidate                                  37         35    2   185/649
```

The self-control ran FIRST and returned 0 of 649. Without it, net +2 is indistinguishable from a
noisy rig.

D-rule violations: **FR 2, GB 4, DE 1**. Iron rule 6 blocks a default-on ship regardless of net.

## The gate disagrees — and the board is the one that matters

|                                                        | verdict        |
| ------------------------------------------------------ | -------------- |
| promotion gate `v9.0.0-base` (per-tag F1, golden sets) | **PASS 18/18** |
| 649-row board (real addresses, truth coordinates)      | **HOLD**       |

Selected floors, all cleared, several by wide margins:

| floor                 |  bar | v5.0.0 |
| --------------------- | ---: | -----: |
| us.street_prefix      | 57.0 |   95.8 |
| us.street_suffix      | 69.9 |    100 |
| us.street             | 67.7 |   73.8 |
| us.locality           | 79.6 |   86.7 |
| fr.region             | 36.7 |   78.5 |
| de.native_locality    | 89.5 |   91.6 |
| fr.bare_street_intact | 75.0 |   97.5 |

**A gate-only promotion would have shipped this model.** `us.street` reads 73.8 — an improvement —
while `Unter den Linden` splits in half. Per-tag F1 over a golden set aggregates away seven specific
addresses in three tier-1 countries. That is the argument for the board being part of the promotion
path, not an adjunct to it.

## The failure has one shape

A multi-word phrase is split and its tail retagged, and the locality is then lost:

```
Unter den Linden
  ! street moved  "Unter den Linden" → "Unter"   [0,16] → [0,5]
  + locality="den Linden"  0.57

St Andrew Undershaft Church, St Mary Axe, London EC3A 8BN
  ! street moved  "St Andrew Undershaft Church" → "St Andrew"
  + dependent_locality="Undershaft Church"  0.38
  ! dependent_locality → locality  "St Mary Axe"   confidence 0.79 → 0.54
  - locality="London"  0.74            <- destroyed

30 St Mary Axe (The Gherkin), 30 St Mary Axe, London EC3A 8BF
  ! venue moved  "St Mary Axe" → "Axe"   confidence 0.54 → 0.34
  + street="St Mary"  0.95
  - locality="London"  0.90            <- destroyed

Cafe at St Mary's, Church of St Mary the Virgin, St Mary's St, Shrewsbury SY1 1BX
  ! unit → region  "Church of St Mary the Virgin" → "Church of St"
  + locality="Mary"  0.04
  + dependent_locality="the Virgin"  0.37
  ~ locality="Shrewsbury"  confidence 0.85 → 0.39
```

The two destroyed `London` localities are the geocoding-relevant damage: the resolver never receives
the city.

## Cause: NOT established. Two variables moved.

|                    | v4.4.0 (shipped)             | v5.0.0                     |
| ------------------ | ---------------------------- | -------------------------- |
| corpus             | `v0.19.0-suffix-boundary-v2` | `v0.27.0-house-venue-intl` |
| admitted countries | 25                           | 134                        |

Neither is attributable from this run. Two hypotheses were floated during the arc and **both were
wrong**, recorded here because each was stated confidently before being checked:

1. _"The from-scratch run discards the suffix-boundary cure."_ **False** — `v0.19.0-suffix-boundary-v2`
   is in v5.0.0's corpus at 30,000 rows.
2. _"Uniform 1.0 weights flatten the mixture, so US drops to a 1/33 share."_ **False** — the loader's
   rejection sampler is `if weight < max_weight`, which never fires when every weight is 1.0. The
   mixture stays proportional to row counts.

What IS measured: four newly-admitted countries carry rows with **zero street rows** — CN 11,357,947,
JP 2,092,821, KR 1,083,156, TW 678,660. That is 15,212,584 rows, **2.23%** of the admitted pool; the
US share moves 73.13% → 71.50%. A 2.23% dose is small for the damage observed, so this is a
hypothesis and not a finding.

## The isolation run

`v5.1.0-nostreetless-60k` — one variable against v5.0.0: those four street-less countries dropped,
134 → 130 admitted, every other weight byte-identical, same corpus, same seed, same schedule.

Pre-registered reading, in the config header:

> If the FR/GB/DE regressions clear, admission is the cause and this is the ship candidate. If they
> persist, the admission hypothesis is FALSIFIED and the corpus change is the remaining suspect — do
> not re-run this with a different dose.

The falsification clause is the load-bearing half. The 2026-08-23 trailing-region arc spent four runs
re-dosing a lever that could not work; a dose is not a fix when the mechanism is wrong.

## Defects found by running the controls first

- **The gate was reporting a crash as a floor failure.** `fr.bare_street_intact` read
  `postcode-us.bin` from the tracked workspace, which is bare by design since the linkers moved to the
  data-root overlay — so it threw ENOENT and the gate printed `✗ FAIL (floor 75%)`. The floor
  actually reads 97.5. No candidate could clear the gate on a dev checkout. Fixed in #1843; found
  because the failing arm was the SHIPPED model, which a candidate cannot be blamed for.
- **`mwdev_coverage` answered about the wrong corpus.** A cached census of `0.26.0` was reported
  against a config training on `0.27.0`; a country the newer corpus added read as zero rows. Fixed in
  #1839, and the wrapper that dropped the guard in #1841.
