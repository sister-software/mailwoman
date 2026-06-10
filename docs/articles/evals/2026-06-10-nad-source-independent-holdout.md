# US source-independent holdout — first numbers (2026-06-10, night-10)

The re-scoped #472: 6,453 rows across 44 states whose Overture provenance chain contains
**zero OpenAddresses-derived datasets** (100% DoT NAD) — rows our training lineage has never
carried. This is the *memorization* axis, orthogonal to the VT/WY/ND *geographic* holdout
(which is geography-independent but lineage-shared). Builder:
`scripts/eval/build-nad-holdout.ts` (deterministic hash sampling, seed 42, release
2026-05-20.0); render: `<number> <street>, <city>, <state> <postcode>`.

## Results (admin-centroid tier; admin-match is the headline, coord secondary)

| parser | locality-match | region-match | resolved | coord p50 | coord p90 |
| --- | --: | --: | --: | --: | --: |
| v4.1.0 | 78.1% | 99.9% | 100.0% | 5.4 km | 106.7 km |
| **v4.2.0** | 77.3% | **100.0%** | 100.0% | 5.5 km | 138.8 km |
| v0 (Pelias rules) | 86.7% | 91.7% | 99.4% | 4.3 km | 24.6 km |

## Finding 1 — no memorization cliff

v4.2.0 vs v4.1.0 on never-seen-lineage data: locality −0.8, region +0.1 — the same
within-noise story as the lineage-shared evals. The consolidation's gains are not riding
memorized OpenAddresses rows. This was the question this holdout exists to answer, and the
answer is clean.

## Finding 2 — the vanity-city gap, quantified at last

v0 beats neural on locality-NAME-match here (86.7 vs ~78) while neural crushes region
(100.0 vs 91.7). NAD's locality field is the *postal* city — exactly the
postal-city/geographic-city divergence #475 targets. The pattern (name miss + region
perfect + p90 blowups on the margin) is the resolver returning the geographically-correct
locality whose WOF name differs from the postal city on the gold row, plus genuine
wrong-locality picks on vanity-city rows. Two consumers of this finding:

1. **#475 (postal_city alias table)** now has its motivating number: closing the alias gap
   is worth up to ~9pp of US locality-name-match on source-independent data.
2. **#478 (arbitration)**: v0's 86.7 locality vs neural's 100.0 region is the per-component
   complementarity argument in one row of a table.

Caveats: admin-centroid coord errors are expected to be tens of km (the harness's own
note); v0's 24.6 p90 reflects its conservative no-resolve behavior on hard rows (99.4%
resolved). The NAD render is one template — format diversity is not this eval's job.

Trust: 6,453 rows ≥ the 1000-row floor → **TRUSTED**. Files:
`data/eval/external/overture-us-nad-holdout.jsonl` + `.report.json`.
