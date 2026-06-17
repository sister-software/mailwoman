# Arbitration layer (#478 inc 3) — the two-leg gate, and why arbitration is not promoted

_2026-06-17. Per-component rule-vs-neural arbitration in the assembled `runPipeline` (default-OFF,
behind `arbitrate`). The arc, in three acts: (1) the **flatten+rebuild v1** passed the arena
label-match (`v0-only` 56.4→27.1%) but **FAILED the coordinate gate catastrophically** — locality −26pp,
coord p50 3.3→1069 km, street+house_number precondition 100→48%; (2) diagnosis pinned it to **loss of
containment**; (3) the **containment-preserving fix-v1** (edits on the nested neural tree, no flatten)
**eliminated the regression** — the coordinate arm now matches neural — **but the arena collapsed to a
net wash (+21/−21, v0-only unchanged at 56.9%)**. The +122 "win" was entirely label-conformance to v0's
decomposition, the very thing that wrecked the geocode; removing the harm removed the apparent gain.
**Verdict: arbitration is not promoted — fix-v1 makes it SAFE but provides no net benefit, while adding
the full v0-parser cost to every parse.** It stays default-OFF. The #566 lesson, twice over: grade the
assembled COORDINATE output, and a label-match "win" toward the other parser is not a quality win._

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
pure-decomposition wins. Then **re-run the coordinate gate (leg 2)** before any promotion.

## Fix-v1 re-gate — regression gone, but no net benefit

Fix-v1 (`applyRuleArbitration` — edits on the nested neural tree; only `rule_preferred` mutates it,
relabel same-span tag disagreements + add rule-only non-overlapping missing tags, never restructure).

**Coordinate leg (300 OA US rows) — regression ELIMINATED:**

| arm | locality-match | coord p50 km | coord p90 km | street+hn precondition |
| --- | ---: | ---: | ---: | ---: |
| neural | 83.0% | 3.3 | 12.5 | 100.0% |
| flatten+rebuild v1 (prior) | 57.0% | 1069.4 | 3182.5 | 48.0% |
| **fix-v1 (edit-in-place)** | **83.0%** | **3.3** | **12.5** | **99.7%** |

Fix-v1's `assembled + arb` matches `neural` to the decimal — the catastrophe is gone, containment holds.

**Arena leg — collapses to a net wash:**

| arena metric | flatten+rebuild v1 | fix-v1 |
| --- | ---: | ---: |
| assembled pass | 72.9% | 43.1% (= raw neural) |
| `v0-only vs ASSEMBLED` | 27.1% | 56.9% (= raw neural) |
| assembled vs raw-neural | +122 / −10 | **+21 / −21** |

The +122 was almost entirely the harmful decomposition-replacement (taking v0's coarser spans to match
its labels) — the same edits the coordinate gate proved wreck resolution. The *safe* fix-v1 (no
restructure) nets nothing on the arena: +21 helpful relabels/adds offset by 21 harmful ones, the
`v0-only` gap unmoved.

## Final verdict — NOT PROMOTED (no net benefit)

Fix-v1 is the correct, containment-preserving arbitration and removes the catastrophic regression — but
it provides **no net benefit**: a no-op on the coordinate product metric, a +21/−21 wash on the arena,
while every arbitrated parse pays the cost of a full v0 rule-parse. There is nothing here worth the
latency. **Arbitration ships SAFE and default-OFF; it is not promoted.**

The durable findings: (1) the `v0-only` arena column conflates "neural is wrong" with "neural is
*differently right*" — arbitrating toward v0 captures both, and the second kind is harmful; (2) for a
model this strong on the addresses we serve, rule-vs-neural arbitration toward v0 is not a quality
lever. The machinery + the safe fix-v1 are banked behind the flag, with the gate instruments, should a
weaker model, a new locale, or a per-tag config (where the data shows arbitration nets positive on a
specific tag) make it worth revisiting.
