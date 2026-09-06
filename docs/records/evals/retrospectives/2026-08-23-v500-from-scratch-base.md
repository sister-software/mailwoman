# v5.0.0 — the from-scratch base that passed the check and failed the board

**Verdict: HOLD.** Not published. The model clears the promotion check 18/18 and is blocked by iron
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

## The check disagrees — and the board is the one that matters

|                                                         | verdict        |
| ------------------------------------------------------- | -------------- |
| promotion check `v9.0.0-base` (per-tag F1, golden sets) | **PASS 18/18** |
| 649-row board (real addresses, truth coordinates)       | **HOLD**       |

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

**A check-only promotion would have shipped this model.** `us.street` reads 73.8 — an improvement —
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
JP 2,092,821, KR 1,083,156, TW 678,660. That is 15,212,584 rows, **2.23%** of the admitted pool by ROW
COUNT; the US row share moves 73.13% → 71.50%. The config's 34-source `source_weights` reweighting
shifts effective sampler shares, so the row arithmetic is approximate — the falsification below
rests on the config diff, not on these share numbers. A ~2% dose is small for the damage observed,
so this was a hypothesis and not a finding.

## The isolation run

`v5.1.0-nostreetless-60k` — one variable against v5.0.0: those four street-less countries dropped,
134 → 130 admitted, every other weight byte-identical, same corpus, same seed, same schedule.

Pre-registered reading, in the config header:

> If the FR/GB/DE regressions clear, admission is the cause and this is the ship candidate. If they
> persist, the admission hypothesis is FALSIFIED and the corpus change is the remaining suspect — do
> not re-run this with a different dose.

The falsification clause is the required half. The 2026-08-23 trailing-region arc spent four runs
re-dosing a change that could not work; a dose is not a fix when the mechanism is wrong.

## Defects found by running the controls first

- **The check was reporting a crash as a floor failure.** `fr.bare_street_intact` read
  `postcode-us.bin` from the tracked workspace, which is bare by design since the linkers moved to the
  data-root overlay — so it threw ENOENT and the check printed `✗ FAIL (floor 75%)`. The floor
  actually reads 97.5. No candidate could clear the check on a dev checkout. Fixed in #1843; found
  because the failing arm was the SHIPPED model, which a candidate cannot be blamed for.
- **`mwdev_coverage` answered about the wrong corpus.** A cached census of `0.26.0` was reported
  against a config training on `0.27.0`; a country the newer corpus added read as zero rows. Fixed in
  #1839, and the wrapper that dropped the guard in #1841.

## Postscript — v5.1.0 falsifies the admission hypothesis (2026-08-24)

The isolation run landed: same corpus, same seed 42, same schedule, CN/JP/KR/TW dropped (134 → 130
admitted, −15.2M street-less rows, every other weight byte-identical).

```
leg                                  improved  regressed  net  differed
self-control (shipped vs itself)            0          0    0     0/649
v5.0.0 (134 countries)                     37         35    2   185/649
v5.1.0 (130, CJK dropped)                  37         43   -6   193/649
```

D-rule: v5.0.0 FR 2 / GB 4 / DE 1 → v5.1.0 **FR 3 / GB 13 / DE 0**. Dropping the street-less
countries did not clear the regressions — GB got worse. **The admission hypothesis is falsified**,
per the pre-registered clause, and no re-dose follows.

Two facts survive the falsification, and they are the yield of the arc:

**1. A 19-row persistent core regresses under BOTH candidates.** The St Mary Axe cluster, `Milford
on Sea Parish Council…`, `Passeig de Gràcia` / `Passeig de Sant Joan`, `Rua Augusta` (both rows),
`COMER parís.méxico` (both rows), `12 MG Road… Bengaluru`, `Tel Aviv-Yafo`, `Port of Spain`. This
core survives the CJK toggle, so it is attributable to what the two runs share: the corpus change
(`v0.19.0-suffix-boundary-v2` → `v0.27.0-house-venue-intl`) and from-scratch-ness itself — still two
confounded variables against the shipped model, and no run so far separates them.

**2. The admission change coincides with 40 changed regression outcomes among 649 board rows.** The
two runs use seed 42, but v5.1.0 removes 15,212,584 training rows from four of v5.0.0's 134 admitted
countries. Those rows are 2.23% of v5.0.0's admitted training-row pool. Sixteen board rows regress
only under v5.0.0 and 24 regress only under v5.1.0, for 16 + 24 = 40 rows whose regression outcome differs.
That comparison measures the admission change plus any training nondeterminism; it does not measure
seed-to-seed variance. The changed outcomes concentrate in bare multi-word streets and GB venues,
including rows the shipped model holds near 0.5 confidence: `Calle de Alcalá`, `Paseo de la
Castellana`, `Via Laietana`, and `Corso Vittorio Emanuele II` regress under v5.1.0 while `Bloor Street
West`, `Rambla de Catalunya`, `Connaught Road Central`, and `Des Voeux Road Central` improve. GB
regressions rise from 4 under v5.0.0 to 13 under v5.1.0; 7 of those 13 regress only under v5.1.0.
The pending seed-43 repeat of the v5.0.0 config is required before assigning any part of this
40-of-649 disagreement to the seed.

Real wins bought by the corpus change, for the record: the standing `es-op3` failure
(`Southeast, Carrer Passeig d'es Port, 15, 07691 Portopetro, Illes Balears, Spain`) improves under
v5.1.0, as does #1744's Bangladesh row (`London College of Legal Studies (South), … Dhaka 1205`).
The D-rule still holds both candidates.

**Where this leaves the line:** shipped v4.4.0 stays. The open next questions, each a run and a
decision, none pre-authorized: a seed-disagreement measurement (same config, different seed — estimates
row-level instability for one seed pair), or the v4.4.0 arc's own path applied forward (a suffix-boundary treatment
fine-tuned ON TOP of the v5.0.0 base rather than another base). Both candidates' artifacts and run
IDs are retained; the board runs are replayable via `{kind:"recorded"}`.

## Postscript 2 — the full three-leg arc: null + cure on the v5.0.0 base (2026-08-24)

The first run of the complete protocol — self-control, null, candidate in one call:

```
leg                                  improved  regressed  net  differed
self-control (shipped vs itself)            0          0    0     0/649
null (v5.0.1 — base recipe, 1k)            38         34    4   182/649
cure (v5.0.2 — suffix-boundary ×4)         37         31    6   175/649
```

**Verdict: HOLD** — D-rule FR 2 / GB 4 / DE 1, unchanged from the base.

Three findings:

1. **The fine-tune tax on this base is ~zero.** The null grades net +4 vs shipped where the v5.0.0
   base graded +2 — continuing the base's own recipe for 1,000 steps costs nothing measurable, unlike
   the v4.4.0 base's measured 10-row tax. A tax is a property of the base and its recipe, not a
   universal constant.
2. **The cure worked, on exactly its target class.** Candidate minus null: net +2, regressions −3 —
   and the three healed rows are `Passeig de Gràcia`, `Passeig de Sant Joan`, and the
   `…Queen St Unit 1…` unit-swallow: the street-prefix/boundary class the suffix-boundary extract
   teaches. Mechanism-consistent, small, and honestly attributed. (Null↔cure share the same base
   init, seed, and steps, so the treatment comparison is not confounded by the separate country-admission change.)
3. **The D-rule core is base-inherited and dose-immune.** FR 2 / GB 4 / DE 1 are identical across
   base, null, and cure: the GB venue cluster (`St Andrew Undershaft…`, `30 St Mary Axe…`,
   `Cafe at St Mary's…`, `Milford on Sea…`), `Unter den Linden`, and the bare-street coin flips. More
   suffix-boundary dose is not the change for these — the venue-boundary class needs its own treatment
   (#1366's territory), or this lineage does not ship default-on.

Artifacts: null int8 `f52ceaf164c4e01d1682dd80f3c6ac8c`, cure int8 `f2d264f09b7d6f269158ab97d1843346`.
Run IDs in the store: control `0bb3f465`, null `e0b9491c`, candidate `c85ef830`.

## Postscript 3 — the routed re-grading supersedes this document's board numbers (2026-08-24)

Every board figure in this retrospective and its first two postscripts was measured through ONE
en-US session per arm (`mwdev_compare` before PR #1875). Great Britain rows never loaded the en-GB
FST, postcode binary, or placetype-pair index — while still producing a country-stratified score.
The stratification made the numbers LOOK per-country; the execution path was not. PR #1875 routes
each board row through its production overlay and records the resolved artifacts; the corrected
measurements live in `scratchpad/HANDOFF-2026-08-24.md` and the run store.

**What survives from postscripts 1–2, and why:**

- The self-controls (0 differed of 649) — the rig was quiet on the path it measured.
- The CJK-admission falsification — v5.0.0 vs v5.1.0 ran the SAME single-config path on both arms,
  so the matched comparison stands: dropping CN/JP/KR/TW did not clear the regressions.
- The ~40-row churn floor — a same-path variance measurement between two matched arms.
- The check-vs-board divergence — the promotion check is package-shaped en-US by design.

**What is superseded:**

- Every absolute net/regressed count. Grades apply to the **372 of 649 rows carrying coordinate
  truth**, not to 649; and foreign-row grades from the unrouted path are not production behavior.
- The D-rule row identities. Under production routing the blocking set is **FR 2 of 45 graded rows
  (`COMER parís.méxico` in its two board contracts, `fr-fork-entity-comer` and
  `venue-toponym-comer-bare`) + GB 2 of 51 (`Biggin Hill, United Kingdom` and
  `Brixton Hill, United Kingdom`); DE 0 of 6.** The GB venue-cluster blocking story
  (`St Andrew Undershaft Church…`, `30 St Mary Axe…`) was an artifact of grading GB rows without
  their overlay.
- The v5.0.1-null / v5.0.2-cure row-level readings, including "the cure healed exactly its 3 target
  rows" — same unrouted path. The parse-level diffs (the deleted `locality="London"`, the Passeig
  retags) remain real observations of the SINGLE-CONFIG en-US parse and stay useful as mechanism
  illustrations of the grammar contract; they are not statements about the production route.

**The corrected campaign table** (board SHA-256 `e3063ff5faebdf2f…`, fingerprint `ddc60394d5c41471`,
commit `ff4bb076c`):

```
leg                                        md5        improved/372  regressed/372  net  changed/649
self-control (shipped vs staged shipped)   98a49b5c…       0             0           0       0
seed-42 placebo fine-tune                  5f34dda7…       6            12          −6      67
reviewed VE postcode-tail treatment        87543df0…      13             9          +4      68
```

Attribution vs the matched placebo: −3 regressions, +10 net. Five of the 13 improvements are the
reviewed Venezuela target class. HOLD stands on two separate grounds the handoff keeps apart: the
D-rule (4 blocking rows, shared with the placebo — inherited, not treatment-caused), and
measurement power (296 vs 292 of 372 at 25 km, p = 0.7187 — no global-accuracy claim).

The lesson worth keeping beside the D-rule itself: **a per-country breakdown of a score is not
evidence that the per-country path ran.** This session audited corpus identity, artifact identity,
and rig quietness — and graded five models through a route production never uses.
