# Release-quality evaluator simulation

Date: 2026-10-20. Issue #2763, implementation step 8 (statistical half). Evaluator under test:
`packages/mailwoman/tools/eval-harness/release/evaluate.ts` at `origin/main` ff8f719f6.

Every rate, minimum and required improvement in this record is a **simulation parameter** chosen to exercise
the evaluator. None is a registered release requirement, none is a proposal, and none is written to
`specs/`. This record recommends no threshold.

## Method

`release/simulate.ts` draws paired per-row outcomes from known true per-country exact parse rates and passes
them to `evaluateReleaseSpec` unchanged, so the bootstrap, the Bonferroni adjustment and the pass, fail and
insufficient-evidence rules are the evaluator's own.

- Per row, the (published, candidate) pair follows from the two true rates and the discordance
  d = P(published != candidate).
- Rows come in groups of `groupSize`. With probability `correlation` a group shares one pair for every member,
  as derived variants of one address would. Otherwise each member draws its own pair. Both marginal rates are
  preserved.
- `grouping: metadata` passes each row's group to the evaluator. `row_identity` omits it, so the evaluator
  treats every row as independent.
- Repeated selection draws k candidates with the same truth against one set of published outcomes. It keeps
  the candidate with the largest measured Q improvement and evaluates it on the same rows or on a freshly drawn
  set.
- Every synthetic spec uses confidence 0.95, Bonferroni and 1000 resamples, and admits `verified_unseen`.

Per scenario, over R evaluations:

- **Coverage:** the fraction of evaluations whose bounds include the true value. A per-check coverage uses
  that check's bounds. Joint coverage requires every check's bounds to include its truth. The nominal joint
  coverage is at least 95%. The nominal per-check coverage under Bonferroni is 1 - 0.05/m, where m is the
  number of checks.
- **Erroneous approval:** the verdict is pass while the truth misses a minimum or the required improvement.
  It is defined only when the truth misses.
- **Erroneous fail:** the verdict is fail while the truth meets every requirement, inclusive. It is defined
  only when the truth meets them.
- **Insufficient evidence:** the share of verdicts that are insufficient evidence.

Every rate carries a 95% Wilson interval over R.

Run: `node packages/mailwoman/tools/eval-harness/release/simulate.run.ts --scenarios
packages/mailwoman/tools/eval-harness/release/simulation-scenarios.json --repetitions 200 --seed 2763 --out
<report>`. R = 200 per scenario. Repetition r draws data from seed 2763 + r and gives the bootstrap the same
seed, seeds 2763 to 2962. The run took 223.4 s of wall time on the lab host, 17:03:20Z to 17:07:03Z, while a
corpus build ran beside it.

## Scenarios

The scenario file is `packages/mailwoman/tools/eval-harness/release/simulation-scenarios.json`, which states
each scenario's rates, sizes, grouping and simulation thresholds. In summary:

| Scenario                         | Countries x rows                                     | Truth (published to candidate)             | Simulation thresholds           | m   |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------ | ------------------------------- | --- |
| equal-sizes-meets                | 5 x 300                                              | 0.80 to 0.82, d 0.10                       | minimum 0.70, improvement 0     | 6   |
| equal-sizes-one-below-minimum    | 5 x 300                                              | EE 0.70 to 0.66, others 0.80 to 0.82       | minimum 0.70, improvement -0.05 | 6   |
| unequal-sizes-meets              | 1 x 2000 + 8 x 40                                    | 0.85 to 0.88, d 0.08                       | minimum 0.70, improvement 0     | 10  |
| small-10-rows                    | 4 x 10                                               | 0.85 to 0.90, d 0.10                       | minimum 0.70, improvement 0     | 5   |
| small-50-rows                    | 4 x 50                                               | 0.85 to 0.90, d 0.10                       | minimum 0.70, improvement 0     | 5   |
| small-10-rows-below-minimum      | 4 x 10                                               | 0.60 to 0.60, d 0.10                       | minimum 0.70, improvement 0     | 5   |
| small-10-rows-near-minimum       | 1 x 10                                               | 0.85 to 0.85, d 0.10                       | minimum 0.90, improvement -0.05 | 2   |
| independent-rows                 | 4 x 400, group size 1                                | 0.80 to 0.82, d 0.10                       | minimum 0.70, improvement 0     | 5   |
| correlated-grouped               | 4 x 400, groups of 5, rho 0.8                        | 0.80 to 0.82, d 0.10                       | minimum 0.70, improvement 0     | 5   |
| correlated-ignored               | as above, group field absent                         | 0.80 to 0.82, d 0.10                       | minimum 0.70, improvement 0     | 5   |
| correlated-ignored-below-minimum | 4 x 400, groups of 5, rho 0.8, group field absent    | 0.67 to 0.67, d 0.10                       | minimum 0.70, improvement -0.05 | 5   |
| correlated-grouped-below-minimum | as above, groups passed                              | 0.67 to 0.67, d 0.10                       | minimum 0.70, improvement -0.05 | 5   |
| boundary-minimum                 | 4 x 400                                              | 0.80 to 0.80, d 0.10                       | minimum 0.80, improvement -0.05 | 5   |
| boundary-improvement             | 4 x 400                                              | 0.80 to 0.82 (improvement 0.02), d 0.10    | minimum 0.50, improvement 0.02  | 5   |
| selection-k1                     | 4 x 300                                              | 0.80 to 0.795 (improvement -0.005), d 0.10 | minimum 0.50, improvement 0     | 5   |
| selection-k50-same-set           | as selection-k1, best of 50 on the same rows         | as above                                   | as above                        | 5   |
| selection-k50-fresh-set          | as selection-k1, best of 50, fresh confirmation rows | as above                                   | as above                        | 5   |

## Results

Percentages with 95% Wilson intervals over R = 200. "n/a" marks a rate the scenario's truth leaves undefined.

| Scenario                         | Rows | Truth meets all | Pass              | Joint coverage    | Lowest per-check coverage    | Erroneous approval | Erroneous fail | Insufficient        |
| -------------------------------- | ---- | --------------- | ----------------- | ----------------- | ---------------------------- | ------------------ | -------------- | ------------------- |
| equal-sizes-meets                | 1500 | yes             | 54.5 [47.6, 61.3] | 94.5 [90.4, 96.9] | AA: 98.0 [95.0, 99.2]        | n/a                | 0.0 [0.0, 1.9] | 45.5 [38.7, 52.4]   |
| equal-sizes-one-below-minimum    | 1500 | no              | 0.0 [0.0, 1.9]    | 93.5 [89.2, 96.2] | AA: 98.0 [95.0, 99.2]        | 0.0 [0.0, 1.9]     | n/a            | 89.0 [83.9, 92.6]   |
| unequal-sizes-meets              | 2320 | yes             | 1.5 [0.5, 4.3]    | 82.5 [76.6, 87.1] | EE: 95.5 [91.7, 97.6]        | n/a                | 0.0 [0.0, 1.9] | 98.5 [95.7, 99.5]   |
| small-10-rows                    | 40   | yes             | 2.5 [1.1, 5.7]    | 19.5 [14.6, 25.5] | CC: 63.0 [56.1, 69.4]        | n/a                | 0.0 [0.0, 1.9] | 97.5 [94.3, 98.9]   |
| small-50-rows                    | 200  | yes             | 26.5 [20.9, 33.0] | 88.0 [82.8, 91.8] | BB: 95.0 [91.0, 97.3]        | n/a                | 0.0 [0.0, 1.9] | 73.5 [67.0, 79.1]   |
| small-10-rows-below-minimum      | 40   | no              | 0.0 [0.0, 1.9]    | 94.5 [90.4, 96.9] | DD: 98.5 [95.7, 99.5]        | 0.0 [0.0, 1.9]     | n/a            | 95.0 [91.0, 97.3]   |
| small-10-rows-near-minimum       | 10   | no              | 18.0 [13.3, 23.9] | 82.0 [76.1, 86.7] | AA: 82.0 [76.1, 86.7]        | 18.0 [13.3, 23.9]  | n/a            | 82.0 [76.1, 86.7]   |
| independent-rows                 | 1600 | yes             | 49.0 [42.2, 55.9] | 97.5 [94.3, 98.9] | AA: 98.5 [95.7, 99.5]        | n/a                | 0.0 [0.0, 1.9] | 51.0 [44.1, 57.8]   |
| correlated-grouped               | 1600 | yes             | 1.5 [0.5, 4.3]    | 90.5 [85.6, 93.8] | BB: 96.5 [93.0, 98.3]        | n/a                | 0.0 [0.0, 1.9] | 98.5 [95.7, 99.5]   |
| correlated-ignored               | 1600 | yes             | 36.0 [29.7, 42.9] | 33.0 [26.9, 39.8] | AA: 77.0 [70.7, 82.3]        | n/a                | 0.5 [0.1, 2.8] | 63.5 [56.6, 69.9]   |
| correlated-ignored-below-minimum | 1600 | no              | 0.0 [0.0, 1.9]    | 31.5 [25.5, 38.2] | AA: 76.0 [69.6, 81.4]        | 0.0 [0.0, 1.9]     | n/a            | 30.0 [24.1, 36.7]   |
| correlated-grouped-below-minimum | 1600 | no              | 0.0 [0.0, 1.9]    | 91.5 [86.8, 94.6] | AA: 97.0 [93.6, 98.6]        | 0.0 [0.0, 1.9]     | n/a            | 92.5 [88.0, 95.4]   |
| boundary-minimum                 | 1600 | yes             | 0.0 [0.0, 1.9]    | 96.0 [92.3, 98.0] | BB: 98.5 [95.7, 99.5]        | n/a                | 2.0 [0.8, 5.0] | 98.0 [95.0, 99.2]   |
| boundary-improvement             | 1600 | yes             | 0.0 [0.0, 1.9]    | 97.5 [94.3, 98.9] | AA: 98.5 [95.7, 99.5]        | n/a                | 0.0 [0.0, 1.9] | 100.0 [98.1, 100.0] |
| selection-k1                     | 1200 | no              | 0.0 [0.0, 1.9]    | 96.5 [93.0, 98.3] | AA: 99.0 [96.4, 99.7]        | 0.0 [0.0, 1.9]     | n/a            | 98.5 [95.7, 99.5]   |
| selection-k50-same-set           | 1200 | no              | 5.0 [2.7, 9.0]    | 65.0 [58.2, 71.3] | objective: 80.5 [74.5, 85.4] | 5.0 [2.7, 9.0]     | n/a            | 95.0 [91.0, 97.3]   |
| selection-k50-fresh-set          | 1200 | no              | 0.5 [0.1, 2.8]    | 94.5 [90.4, 96.9] | BB: 98.0 [95.0, 99.2]        | 0.5 [0.1, 2.8]     | n/a            | 97.5 [94.3, 98.9]   |

The per-check coverage of every check is in the report JSON under `reports[].checks`.

A supplementary run repeated two scenarios with 4000 resamples instead of 1000 (R = 200, seed 2763, 148.8 s for
both):

| Scenario            | Joint coverage, 1000 resamples | Joint coverage, 4000 resamples |
| ------------------- | ------------------------------ | ------------------------------ |
| unequal-sizes-meets | 82.5 [76.6, 87.1]              | 86.0 [80.5, 90.1]              |
| correlated-grouped  | 90.5 [85.6, 93.8]              | 90.0 [85.1, 93.4]              |

## Findings

1. **Observed: a sample in which every row is exact passes with a zero-width interval.** In
   `small-10-rows-near-minimum` the true rate is 0.85 against a simulation minimum of 0.90. Of 200
   evaluations, 18.0% [13.3, 23.9] passed. The probability of a 10/10 sample is 0.85^10 = 0.197. Inferred
   mechanism: when every row in a country is exact, every resample has the value 1, so the percentile bounds
   are [1, 1], and the evaluator's rule (lower bound and estimate at least the minimum) passes. The same
   mechanism explains the 63 to 70% per-country coverage in `small-10-rows`, where 10/10 samples are common at
   a true rate of 0.90. The nominal per-check coverage there is 99%. The percentile bootstrap gives no width on
   a discrete score at 0 or 1 successes or failures. The module's comment says the rounding of the percentile
   index "widens rather than narrows an interval on discrete scores", but rounding cannot widen an interval
   whose resamples are all identical. This is a defect in `evaluate.ts` against the policy sentence "A measured
   score below a requirement cannot pass because its interval is wide": a small sample passes here because its
   interval is spuriously narrow.
2. **Observed: ignoring groups collapses coverage.** With correlated variants (groups of 5, rho 0.8), joint
   coverage is 90.5% with group metadata and 33.0% without. The lowest per-check coverage is 96.5% with
   group metadata and 77.0% without. Without groups, erroneous fails appear (0.5% [0.1, 2.8], 1 of 200, in
   `correlated-ignored`), and the insufficient rate falls because the intervals are too narrow. The evaluator
   grouped by row identity in these scenarios as designed. The finding is that missing group metadata on
   correlated rows invalidates the bounds, and the verdict's `grouping: "row_identity"` field reports this
   without refusing it.
3. **Observed: joint coverage is below nominal with group metadata at the sizes simulated.** Joint coverage is
   90.5% [85.6, 93.8] in `correlated-grouped` (80 groups per country) and 82.5% [76.6, 87.1] in
   `unequal-sizes-meets`, whose 40-row countries reach 95.5 to 98.5% per-check coverage against a nominal 99.5%.
   With 4000 resamples the joint coverage was 90.0% and 86.0%, so the number of resamples is not the main
   cause (inferred). The remaining explanation is the percentile bootstrap's small-sample bias on a bounded
   binomial rate, unknown until compared against an interval with better small-sample behavior (a
   distinguishing test: the same scenarios with a studentized or Wilson-type bound).
   `independent-rows` (400 rows per country) and `equal-sizes-meets` (300) reach 97.5% and 94.5%.
4. **Observed: selecting the best of several candidates on the evaluation rows inflates approval.** With a
   true improvement of -0.005 against a required 0, one candidate was approved in 0.0% [0.0, 1.9] of
   evaluations. The best of 50 evaluated on the same rows was approved in 5.0% [2.7, 9.0], and the objective
   check's coverage fell to 80.5%. The best of 50 confirmed on fresh rows was approved in 0.5% [0.1, 2.8]. The
   rows used to choose a candidate cannot confirm it.
5. **Observed: boundary truths behave as the inclusive rule implies.** With the truth exactly at the minimum,
   98.0% of verdicts are insufficient evidence and 2.0% [0.8, 5.0] are fail. With the truth exactly at the
   required improvement, 100% are insufficient. Neither scenario passes. A truth at the boundary meets the
   requirement under the inclusive rule but cannot be shown to meet it.
6. **Observed: true but small improvements rarely pass at the sizes simulated.** Where the truth meets every
   simulation requirement, the pass rate ranges from 1.5% (`unequal-sizes-meets`, `correlated-grouped`) to
   54.5% (`equal-sizes-meets`). No scenario produced an erroneous approval except findings 1 and 4. This
   measures the evaluator under these simulation parameters only.

## After the fix

Findings 1 to 3 were defects in `evaluate.ts`; the evaluator now computes its bounds differently, and the
current specification moved to `specs/release-requirements.v2.json` (schema 2). Decided changes:

- **Minimum checks** use a Clopper–Pearson interval on the effective count. The clustered sandwich variance of
  the rate over a country's groups gives a design effect, and the effective count is the row count divided
  by it, clamped to between the number of groups and the number of rows. At a rate of 0 or 1 the design
  effect cannot be estimated and the effective count is the number of groups. Clopper–Pearson is exact on
  independent binomial counts and its bound away from 0 or 1 never collapses: 10 exact rows of 10 at the
  per-side tail 0.0125 give a lower bound of 0.0125^(1/10) = 0.645.
- **Difference checks** (a capability's permitted loss and the Q improvement) use an analytic clustered
  sandwich variance of the paired difference per country, summed over the objective countries with weight 1/K, and a
  Student t quantile with Welch–Satterthwaite degrees of freedom. A country with fewer than two groups makes
  the check insufficient. A country whose estimated variance is zero (no discordant group) takes the exact
  zero-event bound q / G, with q = 1 - tail^(1/G), in its place, so a degenerate sample never has zero width
  and decides only once its group count makes that bound narrow. A bound that still has zero width is
  insufficient evidence.
- **Grouping.** Schema 2 requires `statistics.rowsIndependent` with no default. When it is `false`, a check
  that reads a row without a group reports no bounds and is insufficient evidence. v2 sets it to `false`. The
  simulation's synthetic specification also sets it to `false`, so the `row_identity` scenarios now measure
  the refusal: their checks have no bounds, which the coverage columns count as not covering.
- The bootstrap is gone, so schema 2 refuses `resamples` and `seed`, and the verdict reports
  `rowsIndependent`, each check's `method`, `effectiveRows`, `degreesOfFreedom` and `degenerateStrata` in
  place of `failedResamples`.

Same command, scenario set and seeds (R = 200, seeds 2763 to 2962). The "before" run was repeated on
`origin/main` f8d6dece3, finishing at 17:19:13Z on 2026-10-20, and reproduced the Results table above
exactly (238.2 s). The "after" run finished at 17:20:53Z and took 7.4 s. A corpus build ran beside both.

| Scenario                         | Joint coverage before | Joint coverage after | Lowest per-check after       | Pass after        | Erroneous approval after | Erroneous fail after | Insufficient after  |
| -------------------------------- | --------------------- | -------------------- | ---------------------------- | ----------------- | ------------------------ | -------------------- | ------------------- |
| equal-sizes-meets                | 94.5 [90.4, 96.9]     | 96.0 [92.3, 98.0]    | objective: 98.5 [95.7, 99.5] | 52.0 [45.1, 58.8] | n/a                      | 0.0 [0.0, 1.9]       | 48.0 [41.2, 54.9]   |
| equal-sizes-one-below-minimum    | 93.5 [89.2, 96.2]     | 96.0 [92.3, 98.0]    | objective: 98.5 [95.7, 99.5] | 0.0 [0.0, 1.9]    | 0.0 [0.0, 1.9]           | n/a                  | 87.0 [81.6, 91.0]   |
| unequal-sizes-meets              | 82.5 [76.6, 87.1]     | 96.0 [92.3, 98.0]    | BB: 99.0 [96.4, 99.7]        | 0.0 [0.0, 1.9]    | n/a                      | 0.0 [0.0, 1.9]       | 100.0 [98.1, 100.0] |
| small-10-rows                    | 19.5 [14.6, 25.5]     | 98.5 [95.7, 99.5]    | BB: 99.5 [97.2, 99.9]        | 0.0 [0.0, 1.9]    | n/a                      | 0.0 [0.0, 1.9]       | 100.0 [98.1, 100.0] |
| small-50-rows                    | 88.0 [82.8, 91.8]     | 98.5 [95.7, 99.5]    | objective: 99.0 [96.4, 99.7] | 11.0 [7.4, 16.1]  | n/a                      | 0.0 [0.0, 1.9]       | 89.0 [83.9, 92.6]   |
| small-10-rows-below-minimum      | 94.5 [90.4, 96.9]     | 98.5 [95.7, 99.5]    | AA: 99.5 [97.2, 99.9]        | 0.0 [0.0, 1.9]    | 0.0 [0.0, 1.9]           | n/a                  | 95.5 [91.7, 97.6]   |
| small-10-rows-near-minimum       | 82.0 [76.1, 86.7]     | 100.0 [98.1, 100.0]  | AA: 100.0 [98.1, 100.0]      | 0.0 [0.0, 1.9]    | 0.0 [0.0, 1.9]           | n/a                  | 100.0 [98.1, 100.0] |
| independent-rows                 | 97.5 [94.3, 98.9]     | 96.5 [93.0, 98.3]    | DD: 98.5 [95.7, 99.5]        | 48.5 [41.7, 55.4] | n/a                      | 0.0 [0.0, 1.9]       | 51.5 [44.6, 58.3]   |
| correlated-grouped               | 90.5 [85.6, 93.8]     | 94.0 [89.8, 96.5]    | AA: 98.0 [95.0, 99.2]        | 0.5 [0.1, 2.8]    | n/a                      | 0.0 [0.0, 1.9]       | 99.5 [97.2, 99.9]   |
| correlated-ignored               | 33.0 [26.9, 39.8]     | 0.0 (no bounds)      | AA: 0.0 (no bounds)          | 0.0 [0.0, 1.9]    | n/a                      | 0.0 [0.0, 1.9]       | 100.0 [98.1, 100.0] |
| correlated-ignored-below-minimum | 31.5 [25.5, 38.2]     | 0.0 (no bounds)      | AA: 0.0 (no bounds)          | 0.0 [0.0, 1.9]    | 0.0 [0.0, 1.9]           | n/a                  | 100.0 [98.1, 100.0] |
| correlated-grouped-below-minimum | 91.5 [86.8, 94.6]     | 96.0 [92.3, 98.0]    | AA: 98.5 [95.7, 99.5]        | 0.0 [0.0, 1.9]    | 0.0 [0.0, 1.9]           | n/a                  | 92.5 [88.0, 95.4]   |
| boundary-minimum                 | 96.0 [92.3, 98.0]     | 96.0 [92.3, 98.0]    | BB: 98.5 [95.7, 99.5]        | 0.0 [0.0, 1.9]    | n/a                      | 2.5 [1.1, 5.7]       | 97.5 [94.3, 98.9]   |
| boundary-improvement             | 97.5 [94.3, 98.9]     | 96.5 [93.0, 98.3]    | DD: 98.5 [95.7, 99.5]        | 0.0 [0.0, 1.9]    | n/a                      | 0.0 [0.0, 1.9]       | 100.0 [98.1, 100.0] |
| selection-k1                     | 96.5 [93.0, 98.3]     | 97.5 [94.3, 98.9]    | AA: 99.5 [97.2, 99.9]        | 0.0 [0.0, 1.9]    | 0.0 [0.0, 1.9]           | n/a                  | 98.5 [95.7, 99.5]   |
| selection-k50-same-set           | 65.0 [58.2, 71.3]     | 67.5 [60.7, 73.6]    | objective: 80.0 [73.9, 85.0] | 4.5 [2.4, 8.3]    | 4.5 [2.4, 8.3]           | n/a                  | 95.5 [91.7, 97.6]   |
| selection-k50-fresh-set          | 94.5 [90.4, 96.9]     | 96.5 [93.0, 98.3]    | BB: 99.0 [96.4, 99.7]        | 0.0 [0.0, 1.9]    | 0.0 [0.0, 1.9]           | n/a                  | 98.0 [95.0, 99.2]   |

Against the targets (observed):

- `small-10-rows-near-minimum` erroneous approval fell from 18.0% [13.3, 23.9] to 0.0% [0.0, 1.9], below the
  5% target.
- Joint coverage in the grouped scenarios: `correlated-grouped` 94.0% [89.8, 96.5] and `unequal-sizes-meets`
  96.0% [92.3, 98.0]; 95% lies inside both intervals. `correlated-grouped`'s point estimate is below 95%, and
  R = 200 cannot tell 94% from 95%. The 40-row countries of `unequal-sizes-meets` now reach at least 99.0%
  [96.4, 99.7] per check against a nominal 99.5%. Every scenario other than the ungrouped and same-set
  selection ones has joint coverage whose interval includes 95%.
- Missing groups no longer decide: both `row_identity` scenarios are 100% insufficient evidence and report no
  bounds.
- `boundary-minimum` erroneous fail is 2.5% [1.1, 5.7] with the truth exactly at the minimum in four
  countries. The bound allows up to 4 x 0.005 = 2% there (four per-side tails of 0.05/5/2); the interval
  includes it.
- **Still short of nominal: `selection-k50-same-set`**, joint coverage 67.5% and erroneous approval 4.5%
  [2.4, 8.3]. This is finding 4 (selection on the same rows) rather than a bound defect: no interval computed on the rows that chose the
  candidate covers the selected candidate's truth. The fresh-set arm is at nominal (96.5%, 0.0% approval).
  The correction is procedural, confirmation on rows not used for selection, as the policy's development and
  confirmation collections require.
- **Cost (observed):** the exact bounds are more conservative. Pass rates where the truth meets every
  requirement fell in `small-50-rows` (26.5% to 11.0%), `small-10-rows` (2.5% to 0.0%),
  `unequal-sizes-meets` (1.5% to 0.0%) and `correlated-grouped` (1.5% to 0.5%), and stayed level where
  countries hold 300 to 400 rows (`equal-sizes-meets` 54.5% to 52.0%, `independent-rows` 49.0% to 48.5%).

## Limitations

The generative model has one correlation level per country and no structure shared across countries, places or
sources. Rates are constant within a country, so heterogeneity across address patterns is not simulated.
R = 200 bounds a rate of 0 at under 1.9% and resolves differences of a few percentage points only.
