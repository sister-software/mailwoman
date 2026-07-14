# US source-independent holdout — first numbers (2026-06-10, night-10)

The re-scoped #472: 6,453 rows across 44 states whose Overture provenance chain contains
**zero OpenAddresses-derived datasets** (100% DoT NAD) — rows our training lineage has never
carried. This is the _memorization_ axis, orthogonal to the VT/WY/ND _geographic_ holdout
(which is geography-independent but lineage-shared). Builder:
`scripts/eval/build-nad-holdout.ts` (deterministic hash sampling, seed 42, release
2026-05-20.0); render: `<number> <street>, <city>, <state> <postcode>`.

## Results (admin-centroid tier; admin-match is the headline, coord secondary)

| parser            | locality-match | region-match | resolved | coord p50 | coord p90 |
| ----------------- | -------------: | -----------: | -------: | --------: | --------: |
| v4.1.0            |          78.1% |        99.9% |   100.0% |    5.4 km |  106.7 km |
| **v4.2.0**        |          77.3% |   **100.0%** |   100.0% |    5.5 km |  138.8 km |
| v0 (Pelias rules) |          86.7% |        91.7% |    99.4% |    4.3 km |   24.6 km |

## Finding 1 — no memorization cliff

v4.2.0 vs v4.1.0 on never-seen-lineage data: locality −0.8, region +0.1 — the same
within-noise story as the lineage-shared evals. The consolidation's gains are not riding
memorized OpenAddresses rows. This was the question this holdout exists to answer, and the
answer is clean.

## Finding 2 — the census-designation gap (CORRECTED same night)

> **CORRECTION (night-10, hours after first publication):** the first version of this
> section attributed the locality gap to the postal-city/vanity-city divergence (#475).
> The alias-table join MEASURED that attribution and refuted it: only 1 of 461 named
> misses is alias-explained — NAD's locality field carries _census/municipal_ names, not
> postal names, so this eval cannot exhibit the vanity-city failure mode at all.

What the misses actually are (classified, n=461 with a resolved-but-wrong name):

- **54.0% are the SAME PLACE under a different name surface** — census designations:
  `College CDP` ↔ WOF `Fox Farm-College`, `City and Borough of Juneau`, `X Township` ↔
  `X` (NJ alone is 148 of 461 — townships). This is the Plauen-Vogtl name-match-artifact
  class, US edition; the fix lane is the #386-style hierarchy-aware designation credit
  generalized to US census surfaces — filed as its own issue with these numbers.
- The remainder are genuine ranking/disambiguation misses (e.g. Juneau → Wrangell).

Consumers: the designation-credit issue (primary); **#478** still gets its
complementarity row (v0 locality 86.7 vs neural region 100.0). **#475's alias table is
NOT validated by this eval** — it needs an eval whose _inputs_ carry postal surfaces
(real-traffic shaped); noted on the issue.

Caveats: admin-centroid coord errors are expected to be tens of km (the harness's own
note); v0's 24.6 p90 reflects its conservative no-resolve behavior on hard rows (99.4%
resolved). The NAD render is one template — format diversity is not this eval's job.

Trust: 6,453 rows ≥ the 1000-row floor → **TRUSTED**. Files:
`data/eval/external/overture-us-nad-holdout.jsonl` + `.report.json`.

## Morning-after correction №2 (2026-06-10 day): the gold itself was composite

The night's Finding-2 classification was computed on **broken gold**: NAD's locality field
sometimes carries a composite `"County, Municipality"` string (New Jersey systematically —
`"Union, Union Township"`, `"Cape May, Sea Isle City"`), and the holdout builder graded
against the whole composite. Correct resolves failed on the county prefix; NJ's 148
"misses" were ~all this artifact. Builder fixed (last comma segment), holdout rebuilt.

**Corrected numbers (v4.2.0):** locality-match 78.5 (was 77.3), v0 87.7 (was 86.7) — the
fix is fair to both. Misses-with-candidate drop 461 → 317, NJ leaves the top-miss states
entirely, and the strict designation class (`<name> <designation>` ↔ `<name>`) shrinks to
**14 rows (~0.2pp)** — far below implementation threshold. #498 closed as
premise-refuted-by-corrected-measurement. The real residual gap (9.2pp vs v0) is ranking/
coverage misses concentrated in ID/WY/UT/LA plus WOF neighborhood-vs-locality granularity
(`College CDP` ↔ `Fox Farm-College`) — the latter is the PIP lens's territory, not a
name-credit's.

Running tally for this document: three findings published, two corrected by their own
follow-up measurements, within 18 hours. The instrument is part of the experiment.
