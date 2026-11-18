---
title: Release requirements v11, an unread confirmation role from the v0.8.20 split
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v11, an unread confirmation role from the v0.8.20 split

Status: **registered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v11.json` is the
current specification, and `release/current-spec.ts` names it.

## 1. Route: a new version

V10 was read before this change: lane AI scored both v10 roles for 10.8.0, the county pair and the v8.7.0 seeds 42 and
43 ([the v10 record](2026-11-18-release-requirements-v10.md), section 5). Section 6.5 of
[HOLDOUT_AND_EVALUATION](../../engineering/HOLDOUT_AND_EVALUATION.mdx) records every confirmation read in the next
version's rationale, so v11 is a new version and lists them. `release/current-spec.ts` moves to v11 in the same change,
as its docstring requires.

V11 changes the confirmation role and `identities.dataset`. Every other value is v10's: each requirement, the
objective, the statistics, the provenance admission, the scorer, the inference rule, the published identity
(10.8.0, `0bbb3385…e4a4`) and the development role. `requirements.test.ts` asserts that difference.

## 2. The roles

| Role         | v10                                                  | v11                                               |
| ------------ | ---------------------------------------------------- | ------------------------------------------------- |
| development  | `heldout-dev-v0.8.18@771811f7a5a8e4da`               | unchanged                                         |
|              | `heldout-dev-v0.8.19-probes-r2@dd560a53b897dbca`     | unchanged                                         |
| confirmation | `heldout-confirm-v0.8.18@681959088a46e5c6`           | `heldout-confirm-v0.8.20@5b8d9fdd4e80e24b`        |
|              | `heldout-confirm-v0.8.19-probes-r2@8d423f96f9d5a1d4` | `heldout-confirm-v0.8.18-in@672515f2f14bcce8`     |
|              |                                                      | `heldout-confirm-v0.8.20-probes@2a74d78d1ff2f679` |

Each confirmation collection, as the manifest reader verified it on 2026-11-18:

| Collection                       | Rows   | Groups | Rows sha256        | Manifest sha256      |
| -------------------------------- | ------ | ------ | ------------------ | -------------------- |
| `heldout-confirm-v0.8.20`        | 19,757 | 18,584 | `59b12ed5…e058726` | `13e88cc9…88a54a00f` |
| `heldout-confirm-v0.8.18-in`     | 411    | 390    | `7d6f64fc…430acc0` | `e8017e8c…f36203fe`  |
| `heldout-confirm-v0.8.20-probes` | 5,000  | 5,000  | `036879fe…e0e79ee` | `a906112b…f53188`    |

The specification records each full digest. `verifyReportedCollections` reads the three collections as the
confirmation role with no reason, and `mergeHeldoutCollections` joins them with no row identity held twice (25,168
rows).

### 2.1 The main draw

`heldout-confirm-v0.8.20` was frozen by `freeze.run.ts` with seed 1825 at 1,000 rows per country and kind, from the
test rows of corpus `v0.8.19-overlay` (`MANIFEST.json` sha256 `a0234161…d3f8e8`), with every frozen collection already
read excluded: `heldout-dev-v0.8.18@771811f7a5a8e4da` as `sampling.excludes` and 18 more under
`sampling.excludesRead`. Corpus `v0.8.20-retention-overlay` (`MANIFEST.json` sha256
`ce86a79b67c8c8583eadca0459e373c260fcdc8ac6c883673fa083caf18cfc89`) lists its groups in
`packages/corpus/data/holdout/evaluation-groups.v0.8.20.json` and sends them to `test`, so a candidate trained on that
corpus never saw them.

Against 10.8.0's corpus (`v0.8.18-retention-overlay`), the audit `heldout-confirm-v0.8.20.provenance-10.8.0.json`
classes 16,137 rows `verified_unseen` and 3,620 `known_overlap`. Its `verified_unseen` ordinary address groups (address
kind, capability probe sources left out) in the objective countries:

| US  | FR  | GB  | DE  | IN  | ES  | IT  | AU  | NZ  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 732 | 49  | 165 | 777 | 1   | 953 | 997 | 709 | 903 |

Under v10 the comparative rows held 13 US and 73 NZ groups for the seeds.

### 2.2 The 158 known-overlap rows

The audit of `heldout-confirm-v0.8.20` against the `v0.8.20-retention-overlay` resplit, with `--match-text`
(`overlap-heldout-confirm-v0.8.20.json` beside its manifest), finds 0 rows by identity or group. It finds 158 rows in
142 groups whose folded text a training row of another record repeats. It classes them `known_overlap`, which neither
`provenance.admitted.minimum` nor `provenance.admitted.comparative` lists, so no check reads them. They stay in the
collection, because a frozen collection's rows are never edited (section 6.6).

### 2.3 The IN supplement and section 6.5

The main draw holds 1 IN group unseen by 10.8.0. No IN row unseen by 10.8.0 remains in the v0.8.20 corpus family,
so without a supplement the IN stratum of the objective and the geocode check would hold 1 comparative group.
`heldout-confirm-v0.8.18-in` holds the 411 IN rows of `heldout-confirm-v0.8.18@681959088a46e5c6`, unchanged. Its
10.8.0 audit classes 273 rows (273 groups) `verified_unseen` and 138 `known_overlap`. The resplit's audit of
`heldout-confirm-v0.8.18` finds 0 `known_overlap` rows, so a v0.8.20 candidate never saw them either.

Those rows are retired for recipe selection (the v10 record, section 4). Section 6.5 keeps retired rows readable for
the release decision of a candidate already chosen on development, and the collection's `sampling.subset` records that
reason. The conditions that come with it:

- No recipe, seed, checkpoint, decoder or corpus choice may be made by comparing results on these rows.
- 10.8.0, seed 42 and seed 43 have read them under v9 and v10. For those arms the IN strata are not unread evidence,
  and a release report for either seed states that.

### 2.4 The probe sets and the development role

`heldout-confirm-v0.8.20-probes` replaces `heldout-confirm-v0.8.19-probes-r2`, which seeds 42 and 43 read. It was
rendered with seed 1901 (confirm seed 1824), and it excludes every earlier probe set's groups and folded texts and every
row of `v0.8.18-retention`, `v0.8.19-retention` and `v0.8.20-overlay`. The resplit's audit finds 0 `known_overlap` rows
in it.

The development role stays as it is. No rule moves it: development guides selection, and section 6.5 retires only
confirmation rows. The resplit's audits find 0 `known_overlap` rows in `heldout-dev-v0.8.18` (86,845 rows) and
`heldout-dev-v0.8.19-probes-r2` (5,000), and `evaluation-groups.v0.8.20.json` keeps both sets' groups in `test`, so a
v0.8.20 candidate is graded on development rows it never saw. `heldout-dev-v0.8.20-probes@b9526da75e63132f` was built
beside the confirmation probes and stays unregistered, because adding it would change the development rows that seeds
42 and 43 were chosen on.

## 3. Confirmation reads

Every confirmation read made so far, by specification version:

| Date       | Spec | Arm                                   | Collections                                        | Verdict                     |
| ---------- | ---- | ------------------------------------- | -------------------------------------------------- | --------------------------- |
| 2026-11-16 | v8   | v8.7.0 seed 42, postal card           | `heldout-confirm-v0.8.18@8606834b12100089`         | fail                        |
| 2026-11-16 | v8   | seed 42, shaped card and fixed repair | the same                                           | insufficient evidence       |
| 2026-11-17 | v8   | seed 43, graded by lane AD            | `heldout-confirm-v0.8.18`                          | the v9 rationale            |
| 2026-11-17 | v9   | 10.8.0 probe baselines (r1, r2)       | `heldout-confirm-v0.8.19-probes`, `-probes-r2`     | the capability-probe record |
| 2026-11-17 | v9   | 10.8.0 against itself (baseline)      | `heldout-confirm-v0.8.18@681959088a46e5c6` with r2 | fail, from `postal_unit`    |
| 2026-11-17 | v9   | `countyDesignatorFallback` on/off     | the same                                           | fail, from `postal_unit`    |
| 2026-11-17 | v9   | seed 42 `n42-i8`, seed 43 `n43-i8`    | the same                                           | fail, fail                  |
| 2026-11-18 | v10  | 10.8.0 against itself (baseline)      | the same                                           | insufficient evidence       |
| 2026-11-18 | v10  | `countyDesignatorFallback` on/off     | the same                                           | insufficient evidence       |
| 2026-11-18 | v10  | seed 42 `n42-i8`, seed 43 `n43-i8`    | the same                                           | insufficient, insufficient  |

The v8 and v9 rows are the ones v10's rationale lists. The v10 rows are new in v11's.

Lane AK sized this role by re-listing seeds 42 and 43's recorded v10 outcomes under fresh group keys in
`evaluateReleaseSpec` (`scratchpad/2026/11/18/lane-ak/confirm-sizing.ts`), and parsed no row. At 75 groups per country
both the geocode and the objective bounds clear for both seeds, and with IN at 274 groups seed 42 reads geocode lower
+0.0267 and objective lower +0.0350. Those are lane AK's numbers, and this lane didn't re-measure them.

**No model has read `heldout-confirm-v0.8.20` or `heldout-confirm-v0.8.20-probes`.** The only work on them is metadata:
the freeze, the probe build and the overlap audits. Section 6.5 allows one baseline scoring of the published model on
confirmation per specification version.

## 4. The candidate identity

`identities.candidate.sha256` stays `null`, so every verdict under v11 reads `insufficient_evidence` with `the candidate
artifact identity is unregistered`. That's the intended state before a release artifact exists (the v8 record, B3).

The route once the v8.8.0 int8 export exists:

1. Choose the candidate on the development role. `release/evaluate.run.ts` reads the development verdict, and a
   null identity only adds the unregistered reason.
2. Take the sha256 of the exact `model.onnx` that will ship. `evaluate.run.ts` computes it with `sha256File` on the
   arm's `model.onnx`, and `mwdev_arc` refuses a verdict whose digest differs from the graded artifact.
3. Register it by a new version, v12, derived from v11 with `identities.candidate` filled, its rationale listing every
   read of v11, and `release/current-spec.ts` moved in the same change. A specification that was read is never
   amended in place (the v10 record, section 1).
4. Run 10.8.0's one confirmation baseline and the candidate's release read under v12. A baseline held until v12
   leaves v11 with no confirmation read, and the new rows are read once, for the release decision.

## 5. The evaluator can pass under v11

`scratchpad/2026/11/18/lane-ap/v11-pass-proof.ts` evaluates a scratch copy of v11
(`release-requirements.v11-s42.json`, unregistered) whose candidate identity is seed 42's `model.onnx`
(`30172227…37ce89`). The rows are the confirmation role's real rows: identity, country, source, kind, group and expected
tags. Provenance comes from the recorded audits: `known_overlap` when the resplit's audit matches a row, else
`verified_unseen` when 10.8.0's audit does, else `unseen_by_candidate`. That gives 21,280 `verified_unseen`, 3,730
`unseen_by_candidate` and 158 `known_overlap` rows. No 10.8.0 audit of the v0.8.20 probe set exists yet, so the proof
takes its rows as `verified_unseen`, which their build ensures against `v0.8.18-retention`. A release grading needs that
audit.

**The outcomes are synthetic.** A hash of each row's identity sets its exact flag: published at 0.85, and the
candidate as given below, for both the parse and the geocode outcome. No model parsed a row. Bonferroni over 16 checks.

| Arm                                              | Verdict      | Notes                                                            |
| ------------------------------------------------ | ------------ | ---------------------------------------------------------------- |
| candidate 0.95, spliced rows exact               | **pass**     | 16 of 16 pass. Objective +0.101 [+0.073, +0.130] on 5,485 groups |
| candidate 0.95, 1 or 2 misses per spliced source | **pass**     | `venue_unit` 0.970, lower 0.850 at 2 misses                      |
| candidate 0.95, 3 misses per spliced source      | insufficient | `venue_unit` 0.955, lower 0.826                                  |
| candidate 0.95 everywhere                        | insufficient | `venue_unit` 67 groups and `country_token` 98 can't clear 0.85   |
| candidate equal to published                     | fail         | objective 0.000 [−0.018, +0.018], FR minimum fails               |
| candidate 0.75                                   | fail         | 11 checks fail                                                   |
| committed v11, candidate 0.95                    | insufficient | `the candidate artifact identity is unregistered`                |

Observed: the evaluator returns `pass` under v11's thresholds on v11's rows, and returns `fail` or insufficient
evidence on the parity and loss arms.

A finding for the release read: `venue_unit` and `country_token` read only `spliced-sub-venue` (69 rows in the main
draw, 67 admitted) and `spliced-country` (100, 98 admitted), and the probe set holds neither. `venue_unit` therefore
passes at no more than 2 misses, a rate of 0.970 or more. V10's confirmation collection held 77 and 93 such rows, and
seed 42 read `venue_unit` 0.974 on it.

## Reproduce

From the lane worktree, with `node --max-old-space-size=4096`:

- `scratchpad/2026/11/18/lane-ap/collections.ts` prints each collection's identity fields.
- `scratchpad/2026/11/18/lane-ap/unseen-groups.ts` counts the `verified_unseen` groups per objective country.
- `scratchpad/2026/11/18/lane-ap/v11-pass-proof.ts` runs section 5.
