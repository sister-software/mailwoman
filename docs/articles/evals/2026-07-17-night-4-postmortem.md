# Night-4 postmortem — 2026-07-17 (autonomous, 04:36–15:00 UTC)

Living document — sketched during the shift, finalized at hand-off.

## Shift charter

Operator handoff 04:36 UTC: B1 (#727 stage-2 k-best, plan #1134) as the main arc (protected lane,
night 1), P1 (locality name-index #30) as a parallel agent. Publish + train authorized. Context
coming in: v6.5.0 shipped this morning; the v1 rules parser deleted this evening (#1151, seal tag
`legacy-rules-final`); the swap gate runs on coordinate acceptability + the two-guard plausibility
module; cascade probe closed shape-routing with receipts.

## What shipped

- (running log)
- 04:5x — stale-out/ hazard post-deletion FOUND + FIXED: tsc leaves orphaned emit; out/commands/debug.js
  still imported the deleted createAddressParser and crashed the pre-commit hook (a commit silently
  failed). Wiped all out/ trees + recompiled. EVERY pre-deletion checkout will hit this — flag in handoff.
- 05:xx — Dependabot critical #114 + medium #115 (websocket-driver 0.7.4, sockjs/webpack-dev-server
  chain, dev-only exposure) cleared via resolutions pin ^0.7.5 (7f56f603).
- 06:4x — B1 step 3: PT/RO splice v0.12.0-ptro-splice built from 35k WOF PT+RO native surfaces
  (+2,310 pieces, +3.2%, EN-identity PASS; RO comma-below byte-fallback eliminated). Mean-init from
  v381 done; 2k probe launched (v3.9.0, ap-wyS4XeIeCE0mtzo8zDWdaT). SALVAGE CATCH: night-3 falsified
  the OA-sourced splice (uppercase PT / stripped RO) and mechanism-confirmed the WOF re-source as
  v267 with a multi-leg pre-registration demand (fr/it/pl overlap + the broken BR row) — the probe's
  read is AMENDED accordingly: grade parity subsets pt/ro/fr/it/pl/br, not just the target.
- 07:0x — P1 CLOSED via the pre-registered measured-negative exit (PR #1152, docs-only, operator
  merge): decode-time atlas prior structurally cannot separate `…Chevaleret Paris` from `Rue de
Paris` (identical terminal token + membership; emission-gap distributions overlap; a bias that
  flips the targets breaks 3/10 real streets). Fix specified as StreetLocalityEvidence for the
  B1 phase-4 arbiter. Correction: gh issue #30 = NAD adapter; the tracker is the #1101 xfail.
- 07:0x — B1 phase-4a: the REPAIRED rerank measurement (scratchpad/rerank-valid.mjs, full geocode
  cascade after the dark-resolver 0/267 bug) found staged-but-unrun with the v301 span-head cache —
  RUNNING now. This is the arc's central question (how much of oracle@10 0.749 vs seg@1 does
  evidence-based rerank collect) and P1's design routes to exactly this component.

## What went well

-

## What could've gone better

-

## Decisions made autonomously

- B1 sequencing: plan #1134 step 3 (PT/RO tokenizer splice) before step 4 (span-scorer head) —
  the plan's own order; the splice is the proven letter-family (bsplice/nsplice/fr-nsplice
  precedents), independent, and feeds the span head's inputs. Numsplice's failure does NOT
  contraindicate it: that was the NUMERIC manifold (shared bare/contextful digits); letter
  diacritic splices shipped clean three times.
- Noted as historical, not re-litigated: plan #1134's tail still names the 0.90 parity floors as
  the swap gate; superseded by the 2026-07-17 operator criterion ruling + the merged swaps + the
  deletion. The arc now feeds model quality / n-best / plan-5 retrain, not a swap unblock.

## Open questions

- Operator rulings still pending: M4 (NZ tier), M2 (postcode-precision floor value), CJK scope,
  deepparse-data counsel bundling.

## Concrete next steps

-

| metric              | value           |
| ------------------- | --------------- |
| shift window        | 04:36–15:00 UTC |
| models trained      | (tbd)           |
| Modal $             | (tbd)           |
| NaN incidents       | 0               |
| CI failures         | 0               |
| regressions shipped | 0               |
