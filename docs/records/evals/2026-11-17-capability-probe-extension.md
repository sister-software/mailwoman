---
title: Capability-probe extension and the release requirements v9 proposal
role: record
audience: maintainer
owner: evaluation
---

# Capability-probe extension and the release requirements v9 proposal

Status: **proposed**. The operator approved building larger capability-probe draws on 2026-11-17, so that the
`po_box_cedex` and `postal_unit` checks of specification v8 can decide (decisions D3 and D4 of
`2026-11-14-release-requirements-v8.md`). The two probe sets below are frozen and audited. The specification
change of section 5 waits for the operator's approval, and `release/current-spec.ts` still names v8.

## 1. The groups each check needs

V8 declares 15 checks: nine country minima, four capability minima, the `po_box_cedex` loss and the objective.
Bonferroni at 0.95 gives each bound a per-side tail of 0.05 / 15 / 2 = 0.001667. Every probe row is its own group
(its `base_source_id` is null and its `source_id` holds no `#`), so a probe check's effective count is its group
count G. The numbers below come from `clopperPearson` and `studentTUpperQuantile` in `release/bounds.ts`
(scratch script `scratchpad/2026/11/17/lane-aa/groups-needed.ts`).

**Minimum 0.85.** A check passes when the Clopper–Pearson lower bound on pG of G is at least 0.85, and fails when
the upper bound is below it. The smallest deciding G for an assumed rate p:

| Assumed rate p                  | Smallest deciding G | Outcome | Bound at that G  |
| ------------------------------- | ------------------: | ------- | ---------------- |
| 0.800                           |                 492 | fail    | [0.7425, 0.8500) |
| 0.820                           |               1,310 | fail    | [0.7870, 0.8500) |
| 0.870                           |               2,705 | pass    | [0.8500, 0.8883] |
| 0.878 (10.8.0 dev po_box_cedex) |               1,371 | pass    | [0.8500, 0.9026] |
| 0.900                           |                 421 | pass    | [0.8500, 0.9381] |
| 0.930                           |                 159 | pass    | [0.8501, 0.9756] |
| 0.951 (10.8.0 dev postal_unit)  |                  97 | pass    | [0.8503, 0.9922] |
| 1.000                           |                  40 | pass    | [0.8522, 1.0000] |

A rate within a few points of 0.85 needs thousands of groups. The arithmetic is the normal approximation's
`G ≈ z² p (1 − p) / (p − 0.85)²` with z = 2.935, which gives 1,176 at p = 0.878, and the exact interval adds about 200.

**Loss 0.05.** The paired-difference check passes when the lower bound on candidate minus published is at least
−0.05. For a candidate equal to the published model on every unit, the stratum is degenerate, and the evaluator
replaces its variance with `(1 − tail^(1/G)) / G`. The half-width is `t(tail, G − 1) × sqrt((1 − tail^(1/G)) / G)`,
which tends to `2.94 × sqrt(−ln tail) / G = 7.44 / G`:

| G     | Half-width |
| ----- | ---------: |
| 15    |     0.5370 |
| 61    |     0.1235 |
| 98    |     0.0764 |
| 149   |     0.0501 |
| 150   |     0.0498 |
| 2,000 |     0.0037 |

An unchanged model decides from G = 150. A candidate with discordant units needs more, with variance about
`(s − D²) / G` for a share s of discordant units and estimate D: s = 0.05 at D = 0 needs 178, s = 0.10 at D = 0
needs 350, and s = 0.10 at D = −0.02 needs 959. The 15 groups of D3 give 0.537, and the 98 of 10.8.0's reading give
0.076, matching the records.

The draw sizes follow. 2,000 `po_box_cedex` groups decide every rate outside (0.8255, 0.8735), and 1,000
`postal_unit` groups every rate outside (0.815, 0.883). The balanced draw read 10.8.0's `po_box_cedex` rate at
0.8275, inside that first band, a rate the check fails only from 2,290 groups. The sets therefore hold 4,000
`po_box_cedex` groups each (section 3).

## 2. Where the rows come from

The two checks select by source: `po_box_cedex` reads `invented-po-box-cedex` and `invented-postal-guideline`, and
`postal_unit` reads `invented-postal-unit-guideline`. Corpus v0.8.19 was re-split under the evaluation-group
policy (HOLDOUT_AND_EVALUATION section 4.6), so its test split holds only the frozen groups (observed in its
`MANIFEST.json` split counts):

| Source                           |   Rows |  train | val | test |
| -------------------------------- | -----: | -----: | --: | ---: |
| `invented-po-box-cedex`          | 50,000 | 49,872 |   2 |  126 |
| `invented-postal-guideline`      |  6,000 |  5,983 |   2 |   15 |
| `invented-postal-unit-guideline` | 10,000 |  9,924 |   6 |   70 |

The 211 test rows are the v0.8.18 sets' probe rows (159 development, 52 confirmation), and they're skewed: 68 of
10.8.0's 98 development `po_box_cedex` groups are NZ, and 50 of its 61 `postal_unit` groups are NZ. No held-out
supply is left to draw from, and no other source renders these tasks, because the capability is defined by these
three recipes.

Decided: the new rows are a probe-only render of the same three recipes, with seed 1900, kept only where no
training corpus holds the row. `heldout/probes/build.run.ts`:

1. runs `po-box-cedex` (30,000 rows over its training pools, the population its corpus rows came from) and the
   `postal-guideline` and `postal-unit-guideline` generators (2,000 rows per country leg);
2. reads every row of the three sources' files, in every split, from corpora v0.8.18-retention-overlay and
   v0.8.19-retention-overlay, and drops a rendered row whose group or folded text (the overlap audit's
   `overlapTextFoldSQL`) any of them holds, or that repeats an earlier rendered row;
3. draws a development set and then, from what it left, a confirmation set. Each probe leg, a source in one
   country, takes a fixed quota split across its rendered templates (`stratumQuotas`, floor 20), each template's
   rows taken in sha256(`<seed>:<row id>`) order, seeds 1820 and 1821.

Why this source and not another. A fresh render is the one way to add rows of the registered capability without
withholding training rows, which the operator's direction rules out. The rows keep the recipes' source names, so
the v8 selectors read them unchanged. A later corpus render of the same components gets the same `source_id`, hence
the same group, and the evaluation-group list sends that group to `test`. The recipes' `--golden` pools (Vermont and
the hash-held-out localities) would add place novelty, but Vermont alone would stand for the US leg, and v0.8.19
trains on both pools anyway. The draw is stratified by leg because a country mix set by which places happened to
be held out (NZ above) measures that mix rather than the capability.

## 3. The frozen sets and their overlap audits

Both sets were frozen on 2026-11-17 under `/mnt/mw/corpus/heldout/`. The first freeze, 250 rows per
`po_box_cedex` leg, gave 10.8.0 a development estimate of 0.8275 [0.8015, 0.8515] on 2,000 groups, inside the
band that size leaves undecided, (0.8255, 0.8735). At 0.8275 the check needs 2,290 groups, so the sets were
re-frozen at 500 rows per leg before any confirmation row was scored. The first freeze is superseded and no
specification names it.

| Set                              | Version            | Order seed |  Rows | `po_box_cedex` groups | `postal_unit` groups | Rows sha256                                                        |
| -------------------------------- | ------------------ | ---------: | ----: | --------------------: | -------------------: | ------------------------------------------------------------------ |
| `heldout-dev-v0.8.19-probes`     | `35918b253d662895` |       1820 | 5,000 |                 4,000 |                1,000 | `9262b4b22bb29991a77d83dfe7b7282641a377224abfe6a33c3feae6c4a596cb` |
| `heldout-confirm-v0.8.19-probes` | `d9e5eac8fe145dc6` |       1821 | 5,000 |                 4,000 |                1,000 | `1434a079788464eddaf3ff4f3a411a46068e61990097a868b364a3d97ee2255d` |

Legs: `invented-po-box-cedex` US, FR, CA, AU and NZ, and `invented-postal-guideline` DE, IT and AU, at 500 rows
each; `invented-postal-unit-guideline` FR, GB, IT, AU and NZ at 200 each. The render produced 46,000 rows. The
exclusion step read 65,369 groups and 64,897 folded texts from the three sources' files and dropped 1,439 rows,
1,412 of them in `invented-po-box-cedex` (US 661, FR 280, CA 250, AU 132, NZ 89) and 27 in AU
`invented-postal-guideline`. The lineage file `heldout-dev-v0.8.19-probes.lineage.json` records the render, the
files read and each template's draw. The confirmation set records `excludes` naming the development set.

Overlap audits (`overlap.run.ts --match-text`) read corpus v0.8.18-retention-overlay (808 files, 623,020,227 rows)
and v0.8.19-retention-overlay (1,097 files, 887,124,044 rows), with the 10.8.0 card
(`/mnt/mw/models/arms/published-11.1.0/…/neural-weights-en-us/model-card.json`) and
`v8.7.0-base-c6-90k-usgs-structures-s42.yaml` as the candidate:

| Audit file under `/mnt/mw/corpus/heldout/`       | verified_unseen | unseen_by_candidate | known_overlap | unknown | Files with a match |
| ------------------------------------------------ | --------------: | ------------------: | ------------: | ------: | -----------------: |
| `heldout-dev-v0.8.19-probes.provenance.json`     |           5,000 |                   0 |             0 |       0 |         0 of 1,905 |
| `heldout-confirm-v0.8.19-probes.provenance.json` |           5,000 |                   0 |             0 |       0 |         0 of 1,905 |

No row of either set matches a training or validation row of either corpus by identity, group or folded text.

`packages/corpus/data/holdout/evaluation-groups.v0.8.19.json` lists 100,486 groups: the v0.8.18 sets' 60,188 and
30,298, and the probe sets' 5,000 and 5,000, none shared. A re-split under it needs a new validation quota pass,
because a validation list records the frozen list's sha256 (section 4.6).

## 4. 10.8.0 against itself on the extension

Arm `/mnt/mw/models/arms/v870/roots/shipped-10.8.0` (`model.onnx` sha256 `0bbb3385…a4`, the registered published
identity) as both arms, spec v8 as registered, Bonferroni over 15 checks. Reports and verdicts:
`/mnt/mw/models/arms/heldout-{dev,confirm}-v0.8.19-probes-published-10.8.0.json` and
`/mnt/mw/models/arms/verdict-{dev,confirm}-v0.8.19-probes-10.8.0-self.json`.

| Check                  | Probe rows alone, development  | Outcome | Pooled with v0.8.18 development | Outcome |
| ---------------------- | ------------------------------ | ------- | ------------------------------- | ------- |
| `po_box_cedex` minimum | 0.8283 [0.8101, 0.8454], 4,000 | fail    | 0.8294 [0.8116, 0.8463], 4,098  | fail    |
| `po_box_cedex` loss    | 0.0000 [−0.0019, 0.0019]       | pass    | 0.0000 [−0.0018, 0.0018]        | pass    |
| `postal_unit` minimum  | 0.6790 [0.6342, 0.7216], 1,000 | fail    | 0.6946 [0.6516, 0.7354], 1,061  | fail    |

The confirmation probe set was scored once, as 10.8.0's baseline read of it, recorded here for the v9 rationale.
Its probe rows give `po_box_cedex` minimum 0.8315 [0.8135, 0.8485] on 4,000 groups, a fail, and loss 0.0000
[−0.0019, 0.0019], a pass. `postal_unit` reads 0.6890 [0.6445, 0.7312] on 1,000 groups, a fail. No v0.8.18
confirmation row was rescored.

All three checks now decide, where v8 returned `insufficient_evidence` on 98 and 61 groups. The pooled verdict is
`fail`: every country minimum, `venue_unit` and `country_token` pass, the objective stays insufficient at
[−0.034, 0.034] (B2, a candidate at parity), and the candidate identity is unregistered.

The published model misses both minima on the balanced draw. Exact rows per development leg:

| Source                           | AU      | CA      | DE      | FR      | GB      | IT      | NZ      | US      |
| -------------------------------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- |
| `invented-po-box-cedex`          | 436/500 | 497/500 |         | 500/500 |         |         | 499/500 | 399/500 |
| `invented-postal-guideline`      | 116/500 |         | 500/500 |         |         | 366/500 |         |         |
| `invented-postal-unit-guideline` | 65/200  |         |         | 15/200  | 200/200 | 200/200 | 199/200 |         |

The v0.8.18 sets read 0.878 and 0.951 because 68 of 98 and 50 of 61 groups were NZ, a leg 10.8.0 reads almost
perfectly. AU `postal-guideline` (Australia Post delivery types), FR unit lines and AU unit types set the two
failures, and US PO boxes cost 101 rows. Under `HOLDOUT_AND_EVALUATION.mdx` P3 the published model's miss informs
the work and doesn't block a repair candidate. Which of those legs is a model deficiency and which a labeling
convention the gold encodes is unknown until their rows are read.

## 5. The proposed specification change, v9

Not registered. The live specification stays v8 until the operator approves. Version 9 would keep every v8
threshold, selector, statistic, provenance rule and identity, and change two things.

1. **Each evaluation role lists its collections.** The spec model reads one collection id per role, and the
   evaluator reads one report. V9 would register:

   ```json
   "evaluations": {
     "development": {
       "ids": ["heldout-dev-v0.8.18@00c4698a7fdc6edf", "heldout-dev-v0.8.19-probes@35918b253d662895"],
       "description": "…both manifests and rows sha256…"
     },
     "confirmation": {
       "ids": ["heldout-confirm-v0.8.18@8606834b12100089", "heldout-confirm-v0.8.19-probes@d9e5eac8fe145dc6"],
       "description": "…"
     }
   }
   ```

   and `identities.dataset` would list both confirmation collections with their rows sha256. A report scores
   every collection of a role, and the evaluator reads the joined outcomes. Country checks and the objective
   leave probe sources out already (`capabilityProbeSources`), so only `po_box_cedex` and `postal_unit` read the
   new rows. The v0.8.18 probe rows stay in the pool beside them.

2. **The rationale records the confirmation read**: 10.8.0's one baseline scoring of the confirmation probe set
   (section 4), allowed once per specification version by section 6.5 of the specification.

The registration needs code that isn't written yet. `requirements.ts` would read `ids` as a non-empty list.
`heldout/per/country.run.ts --dataset` would take several manifests, refuse two that share a row identity, and
record each in the report's `dataset` field. `release/evaluate.ts` stays unchanged. Section 4's pooled reading
was made with a scratch join of two reports (`scratchpad/2026/11/17/lane-aa/pool-reports.ts`), the same outcomes
such a report would hold.

The alternative, a probe-only selector (`select.collections`) so that the two checks read only the stratified
rows, was weighed and not proposed. The v0.8.18 probe rows number 159 and 52 against 5,000 per set, and pooling
moved the development estimates by 0.11 and 1.56 points. A selector by collection would also need every outcome
row to record its collection id.
