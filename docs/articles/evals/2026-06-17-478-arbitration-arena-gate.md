# Arbitration layer (#478 inc 3) — arena capability gate

_2026-06-17. Increment 3 wires per-component rule-vs-neural arbitration into the assembled
`runPipeline` (default-OFF, behind `arbitrate`). This records the first of the two pre-registered gate
legs — the arena capability gate, graded on the ASSEMBLED pipeline (the #566-lesson instrument inc 1
added), not raw neural. The second leg (precondition + coordinate, on the non-circular holdouts) is the
promotion gate and is run separately before any mode flips to default-on._

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

## Gate status

- **Leg 1 (arena capability): CLEARS.** `v0-only vs ASSEMBLED` halved (56.4 → 27.1%), `neural-only`
  retained (0 lost in that column), no `both-fail` added; +122/−10 vs raw neural.
- **Leg 2 (precondition + coordinate): the promotion gate, run separately.** `oa-resolver-eval` on the
  non-circular holdouts (Travis E-911 + OpenAddresses) — street+house_number+postcode precondition must
  not regress vs argmax and coord-error percentiles must hold. Per-component modes promote to default
  ONLY where both legs clear.

Arbitration ships **default-OFF** (`opts.arbitrate`); this report is the capability evidence, not a
promotion. The machinery + this gate instrument land together; the promotion decision rides leg 2.
