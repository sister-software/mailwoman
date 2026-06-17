# Arbitration layer (#478 inc 3) — the two-leg gate (arena PASS, coordinate FAIL → not promoted)

_2026-06-17. Increment 3 wires per-component rule-vs-neural arbitration into the assembled
`runPipeline` (default-OFF, behind `arbitrate`). The two pre-registered gate legs split decisively:
**leg 1 (arena label-match) passes strongly** — arbitration nearly halves the `v0-only` gap; **leg 2
(precondition + coordinate) FAILS catastrophically** — it drops locality-match 26pp, blows coord p50
from 3.3 km to 1069 km, and loses the street+house_number precondition on half the rows. Arbitration is
**not promoted**; it stays default-OFF. This is the #566 lesson reproduced in real time: a layer that
"can't score below v0 by construction" is only true if you grade the ASSEMBLED COORDINATE output — the
arena's loose label-match made arbitration look like a clean win it isn't. Leg 2 is exactly why the gate
runs before any flip to default-on._

## What ran

`scripts/harness-v0-neural.ts --tests mailwoman/test --admin-fst <en-us> --postcode-repair --assembled
--arbitrate` — the 376-assertion arena, the bundled en-us model, graded three ways: v0 (rules), raw
neural, and the assembled `runPipeline`. Arbitration unions the whole-text neural parse with the solved
v0 rule parse (as proposals), filters per-component by the input-shape router prior, resolves span
overlaps (the coherence pass), and rebuilds the tree.

## Result — arbitration nearly halves the v0-only gap

| graded arm | assembled/parser pass | **v0-only vs ASSEMBLED** (gate target → ~0) |
| --- | ---: | ---: |
| v0 (rules) | 100.0% | — |
| raw neural | 43.1% | 56.9% |
| assembled, no arbitration (inc 1 baseline) | 43.6% | 56.4% |
| **assembled + arbitration** | **72.9%** | **27.1%** |

Against raw neural the arbitrated pipeline is **+122 / −10**: it captures 122 parses neural alone drops
(the v0 wins, kept "by construction" — the router routes clean structured input to the rule source and
the registry keeps it) and loses 10 (cases where neural was right and arbitration preferred the rule
parse). The run is clean across all 376 assertions, no errors.

## Reading

- **The thesis holds.** Per-component arbitration closes the arena's `v0-only` column the way #478
  predicted — the pipeline keeps whichever source is right per component, so it stops scoring below v0
  on the components v0 wins. `v0-only vs ASSEMBLED` moves **56.4% → 27.1%** with arbitration on.
- **It is not yet ~0.** The residual 102 cases are where, after the router's mode choice + the
  coherence pass, neither surviving source matched v0. That is the router/config tuning frontier (which
  tags route to which source per shape) — deferred, and exactly what the per-tag `from-config` overlay
  exists to A/B without code edits.
- **The −10 is the watch item.** Ten cases the arbitrated pipeline loses vs raw neural are the
  precondition-style risk: a rule parse winning a component where neural was correct. The coordinate
  leg below is what confirms these don't translate into a street+house_number precondition or
  coordinate regression — the gate that the original #427 re-promotion skipped.

## Leg 2 — the coordinate gate (FAILS)

`scripts/eval/oa-resolver-eval.ts --assembled` routes each row through `createRuntimePipeline` (same
neural classifier with postcodeRepair, `placeCountry` OFF for comparability, same resolver) — without
(`assembled`) and with (`assembled + arb`) arbitration. 300 OpenAddresses US rows, admin-centroid tier:

| arm | locality-match | region-match | coord p50 km | coord p90 km | street+hn precondition |
| --- | ---: | ---: | ---: | ---: | ---: |
| neural | 83.0% | 99.7% | 3.3 | 12.5 | 100.0% |
| assembled (no arb) | 83.0% | 99.7% | 3.3 | 12.5 | 100.0% |
| **assembled + arb** | **57.0%** | 100.0% | **1069.4** | **3182.5** | **48.0%** |

The `assembled (no arb)` arm reproduces `neural` to the decimal — the **instrument is sound**, so the
regression is fully attributable to arbitration (the only delta is `arbitrate: true`). Arbitration:

- **drops locality-match 83.0% → 57.0%** (−26pp) — it produces locality/region values that resolve to
  the wrong place (a namesake city in another state), which is what blows the coord p50 from **3.3 km to
  1069 km**;
- **loses the street+house_number precondition on half the rows** (100% → 48%) — the #566 failure mode
  directly: components that anchor the street-level geocode are dropped in the union → arbitration →
  coherence → flat-rebuild path.

This is invisible to leg 1 because the arena scores loose top-1 label-match (does the parse name the
same components as v0), not the resolved coordinate. Arbitration makes the labels look more v0-like
(+122) while wrecking the geocode — the exact gap the #566 reconcile-retirement warned the gate must
close.

## Gate status — NOT PROMOTED

- **Leg 1 (arena label-match): clears.** `v0-only vs ASSEMBLED` 56.4 → 27.1%, +122/−10 vs raw neural.
- **Leg 2 (precondition + coordinate): FAILS decisively.** locality −26pp, coord p50 3.3 → 1069 km,
  precondition 100% → 48%.

**Both legs must clear to promote; leg 2 fails, so arbitration stays default-OFF.** The machinery and
both gate instruments are merged; no default changes. The methodology did its job — it caught a
catastrophic coordinate regression that the label-match arena scored as a +122 win.

## Diagnosis — one root cause: loss of containment

`scripts/eval/probe-arbitration.ts` traces the arbitration stages on real US addresses. The aggregate
over 60 clean rows is decisive — **both** failure modes are the same root cause: the flat
proposal/tree representation has no containment.

- **Precondition (street dropped 42%, all by overlap eviction).** Neural emits `street` + a separate
  `street_suffix`/`street_prefix` (e.g. `street[4,12]"Seminary"` + `street_suffix[13,15]"Dr"`); the
  solved v0 parse emits the combined `street[4,15]"Seminary Dr"`. Under `rule_preferred` both survive
  arbitration (v0 has no `street_suffix`), then the coherence pass — which only knows intervals, not
  that a suffix is *part of* a street — sees `street_suffix` (conf 0.94) overlapping `street` (conf
  0.82) and **evicts the street**, leaving a dangling suffix and no street. Measured: 25/60 rows drop
  street, **25/25 by this overlap eviction**. (When v0's street outranks the neural suffix, it
  survives — the ~50/50.)
- **Coordinate (locality resolves to a wrong-state namesake).** The probe shows locality/region
  *values* are byte-identical to neural (**0/60** changed) — yet they resolve to the wrong place. The
  only difference is the tree: the nested neural argmax tree vs the **flat** `proposalsToTree`. The
  resolver loses the region→locality containment constraint and resolves the same `"Mill Valley"`
  string globally to a wrong-state namesake. (DeepSeek's flagged flat-tree risk — the resolver-output
  no-op was never asserted, only tree shape.)

## Fix plan (DeepSeek-coordinated) — edit the neural tree, don't rebuild flat

Apply arbitration as **edits on the nested neural argmax tree** instead of flatten → arbitrate →
`proposalsToTree`. This preserves containment by construction, so the coherence pass becomes
unnecessary and the resolver keeps its structure. The v1 edit algorithm:

- `neural_preferred` / `abstain` routes → pass the neural tree **unchanged**.
- `rule_preferred` → **override a neural node's value only** when a same-tag rule proposal overlaps it
  with a different value; **add rule-only missing tags** as nodes; **never restructure** (no dropping
  neural's sub-component decomposition, no flattening).

This makes clean-address arbitration a **no-op** (killing both regressions), captures the high-value
wins (value disagreements + tags neural missed entirely), and accepts losing the low-value
pure-decomposition wins. Then **re-run the coordinate gate (leg 2)** before any promotion. Until that
lands and clears, arbitration stays a measured-negative behind the default-off flag.
