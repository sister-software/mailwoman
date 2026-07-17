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
