---
title: Release requirements v8 proposal and evaluator readiness on corpus v0.8.18
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v8 proposal and evaluator readiness on corpus v0.8.18

Status: **unregistered proposal**. The live specification stays
`packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v7.json`. The proposal is
`packages/mailwoman/tools/eval-harness/release/specs/proposals/release-requirements.v8.proposal.json`. It registers the two
evaluation collections below and changes no threshold. The operator approves it, amends it, or rejects it.

This record answers the pre-launch question of `HOLDOUT_AND_EVALUATION.mdx` P3 for the next run on
`v0.8.18-retention-overlay`. The first question is whether every required check can read admissible evidence. It
can't. Section 4 lists what blocks a `pass`.

## 1. The frozen collections

Both were frozen on 2026-11-14 with `heldout/dataset/freeze.run.ts` from
`/mnt/mw/corpus/versioned/v0.8.18-retention-overlay/corpus-v0.8.18-retention-overlay/MANIFEST.json` (sha256
`2241efda2892634dc8b4b50ceddef6708680b95adf38055f2ae020a5d236a9d0`), 1,000 rows per country and row kind, skipping
`part-deepseek-kryptonite-train.parquet` as the v0.8.12 freeze did.

| Collection                | Version            | Seed | Rows   | Sources | Rows sha256                                                        | Manifest sha256                                                    |
| ------------------------- | ------------------ | ---- | ------ | ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `heldout-dev-v0.8.18`     | `187e8ab06b37351c` | 1818 | 84,926 | 128     | `d47011c2f200f3d0f99ae3b017bc1487a9ef8ad869806ecb20ba087323b17a09` | `5bf84e1cdcb3a3f2c64b94aa058efafda6896d6ec972f1fa70b1059eff83f75d` |
| `heldout-confirm-v0.8.18` | `35ba77d61aa40921` | 1819 | 33,846 | 54      | `b1bf658e5312efa7ce8f7e092b3039bab36bf449a7d47b5990ec0399e71dbfc8` | `9ca0bbe51b06e51a777359f33a58fb948450cf0562d98bb96045cf8121dcbf50` |

The confirmation collection was drawn with `--exclude-dataset` naming the development manifest, so the two are
disjoint by group. It's smaller because the development draw took every group of most small countries.

Overlap audits (`heldout/dataset/overlap.run.ts`) read both lineages: corpus v0.8.18-retention-overlay (808 files,
623,020,227 rows) and v0.7.10-gb-county (965 files, 706,364,298 rows), with the 10.7.0 model card and
`v8.6.3-base-c6-90k-v0818-wof15-s42.yaml`.

| Audit file under `/mnt/mw/corpus/heldout/`                 | Candidate | verified_unseen | unseen_by_candidate | known_overlap |
| ---------------------------------------------------------- | --------- | --------------: | ------------------: | ------------: |
| `heldout-dev-v0.8.18.provenance.json`                      | v8.6.3    |          11,209 |              25,744 |        47,973 |
| `heldout-dev-v0.8.18.provenance-shipped-as-candidate.json` | 10.7.0    |          11,209 |              36,451 |        37,266 |
| `heldout-confirm-v0.8.18.provenance.json`                  | v8.6.3    |           2,562 |              21,649 |         9,635 |

The audit counts a group as exposed when any of its rows sits in a train or val file. Of 972 US development rows
classed `known_overlap` for v8.6.3, the matches lie in `.val` attribute files (`usgov-nad.val` 767, `tiger.val`
104, `usgov-nppes.val` 89) and in `wof-postalcode`: a record's test row with its `+drop-commas` variant in val, the
straddle section 5.1 of the specification counts (observed).

Admitted address rows per required country (capability-probe sources excluded), development collection:

| Country | verified_unseen (rows / groups) | unseen_by_candidate, v8.6.3 | known_overlap |
| ------- | ------------------------------: | --------------------------: | ------------: |
| US      |                         24 / 24 |                           4 |           972 |
| FR      |                         52 / 52 |                           0 |           948 |
| GB      |                       853 / 849 |                           0 |           107 |
| DE      |                       761 / 759 |                           0 |           105 |
| IN      |                         73 / 71 |                         435 |           492 |
| ES      |                               0 |                         959 |            40 |
| IT      |                               0 |                         998 |             2 |
| AU      |                               0 |                         615 |           354 |
| NZ      |                               0 |                         426 |           456 |

The confirmation collection repeats the pattern: verified_unseen US 10, FR 57, GB 884, DE 792, IN 39, ES, IT, AU and
NZ 0. NZ holds 73 address rows in all.

## 2. Measured basis of every v7 threshold

10.7.0 int8 (`model.onnx` sha256 `e90aeab4…d9aca9`, root `/mnt/mw/models/arms/fp32master/roots/shipped-i8`) was
scored on the development collection with `heldout/per/country.run.ts --dataset` (report
`/mnt/mw/models/arms/heldout-dev-v0.8.18-shipped-vs-p30.json`), under the shipped-as-candidate audit. The
evaluator ran with 10.7.0 as both arms. Bounds are simultaneous: Bonferroni over 15 checks, per-side tail
0.00167. No confirmation row was scored.

| Check           | v7 value  | 10.7.0 estimate | Bound           | Rows / groups | v7 outcome   | Proposal              |
| --------------- | --------- | --------------: | --------------- | ------------- | ------------ | --------------------- |
| `country-US`    | 0.60      |           0.890 | [0.854, 0.920]  | 791 / 791     | pass         | keep                  |
| `country-FR`    | 0.90      |           0.993 | [0.981, 0.998]  | 999 / 996     | pass         | keep                  |
| `country-GB`    | 0.80      |           0.955 | [0.931, 0.973]  | 914 / 900     | pass         | keep                  |
| `country-DE`    | 0.85      |           0.870 | [0.832, 0.902]  | 815 / 811     | insufficient | keep, decision D1     |
| `country-IN`    | 0.50      |           0.211 | [0.116, 0.335]  | 142 / 117     | fail         | keep, decision D2     |
| `country-ES`    | 0.80      |               — | —               | 0             | insufficient | keep, blocker B1      |
| `country-IT`    | 0.80      |               — | —               | 0             | insufficient | keep, blocker B1      |
| `country-AU`    | 0.80      |           0.500 | [0.001, 0.999]  | 2 / 2         | insufficient | keep, blocker B1      |
| `country-NZ`    | 0.80      |               — | —               | 0             | insufficient | keep, blocker B1      |
| `po_box_cedex`  | 0.85      |           0.533 | [0.174, 0.868]  | 15 / 15       | insufficient | keep, decision D3     |
| `po_box_cedex`  | loss 0.05 |           0.000 | [−0.537, 0.537] | 15 / 15       | insufficient | keep, decision D3     |
| `venue_unit`    | 0.85      |           0.972 | [0.859, 0.999]  | 71 / 71       | pass         | keep                  |
| `country_token` | 0.85      |           0.989 | [0.905, 1.000]  | 87 / 87       | pass         | keep                  |
| `postal_unit`   | 0.85      |           0.033 | [0.001, 0.162]  | 61 / 61       | fail         | keep, decision D4     |
| objective       | 0         |               — | —               | 1,763 / 1,755 | insufficient | keep, blockers B1, B2 |

A row-level minimum for 10.7.0 reads rows 10.7.0 never trained on, so the US, DE and GB rows above include rows
v8.6.3's corpus holds. The proposal keeps every v7 value. Each number in the table is the measured basis an
amendment would start from, and the published model's answers do not set a minimum by themselves
(`CONTRIBUTING_MODEL_WORK.mdx`, item 5).

## 3. Decisions the measurements raise

- **D1, DE.** 10.7.0 reads 0.870 on 811 groups, and the bound crosses 0.85. A 0.87 model needs more groups to show it
  meets 0.85, and DE holds 12,772 test address rows. A larger DE quota costs less than a lower minimum.
- **D2, IN.** 110 of the 142 admitted IN rows come from `geonames-features` (71) and `wikidata-vital-places` (39).
  10.7.0 parses none of them exactly. On `osm-in` it parses 29 of 30. `heldoutRowKind` classes only `wof-*` sources as
  gazetteer rows, so these place-name sources enter the address minimum (observed). Across all countries
  `geonames-features` contributes 1,048 verified_unseen rows at 0% exact. A reclassification of the two sources as gazetteer
  rows changes the row kind of every collection frozen since they were added, so it needs its own decision.
- **D3, `po_box_cedex`.** 15 admitted groups give a half-width of about 0.35 on the minimum and 0.54 on the loss. No
  value inside [0, 1] lets an unchanged model pass the loss check at this size. The probe sources need a larger
  admitted draw.
- **D4, `postal_unit`.** 10.7.0 parses 2 of 61 `invented-postal-unit-guideline` rows exactly. The published model
  misses this minimum. `HOLDOUT_AND_EVALUATION.mdx` section 7.1 item 3 calls that a conflict to investigate. Under
  P3 it informs the work and leaves a repair candidate free to launch.

## 4. What blocks a `pass`

- **B1. No comparative evidence for ES, IT, AU or NZ.** The objective admits `verified_unseen` rows only, and both
  collections hold none in those four countries: 10.7.0 trained on v0.7.10's rows of them. The objective is
  therefore `insufficient_evidence` for every candidate until an evaluation source outside both lineages exists
  (section 6.4 of the specification). A self-control has no admissible minimum rows there either.
- **B2. A candidate at parity never passes the objective, by decision.** The v3 record, section 4, decided
  `minimumImprovement: 0` and rejected a non-inferiority margin. On the five objective countries with comparative
  rows, 10.7.0 against itself gives Q difference 0 with bound [−0.0675, 0.0675]. US contributes 24 groups and
  dominates the width. A known-good artifact that passes is therefore a candidate with a measured gain in the
  objective.
- **B3. The candidate identity.** `identities.candidate.sha256` is `null` in every specification until a release
  artifact exists, and the evaluator reports a `null` identity as insufficient evidence. That's the intended
  state before a release.

## 5. Dry-run demonstration

To show that the evaluator can return `pass` and `fail`, a scratch copy of v7 was evaluated. The copy stays
unregistered, under `scratchpad/2026/11/14/`. The copy filled the candidate identity, kept the five countries with comparative rows (US, FR, GB, DE, IN), and
set each minimum to the lesser of v7's value and 10.7.0's lower bound, rounded down to 0.05: DE 0.80, IN 0.10,
`po_box_cedex` 0.15, `postal_unit` 0, `po_box_cedex` loss 0.55, objective −0.07. These values exist only to exercise
the decision rule. They're not proposed, because each one encodes the published model's current answers.

| Candidate arm                                   | `model.onnx` sha256 | Verdict | Checks                                                                                                                          |
| ----------------------------------------------- | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 10.7.0 against itself                           | `e90aeab4…d9aca9`   | pass    | 11 of 11 pass. Objective 0.000, bound [−0.0675, 0.0675] against −0.07                                                           |
| WOF-only primer, step 30,000 (`screen/P30-s42`) | `e3363908…0413a4`   | fail    | 8 fail, 2 insufficient (`po_box_cedex` minimum and loss), 1 pass (`postal_unit` at 0). Objective −0.820, bound [−0.871, −0.769] |

The primer parses 0.51% of 57,715 address rows exactly against 10.7.0's 67.42%. Its outcomes were classed under
the shipped-as-candidate audit. That suits a mechanics check, and a release grading would audit the primer's own
lineage.

Under the unmodified v7 thresholds, the same 10.7.0 self-control returns `fail` (IN and `postal_unit`), with ES,
IT, AU, NZ, DE, `po_box_cedex` and the objective insufficient.

## 6. Coverage register

`docs/engineering/reference/evaluation-coverage.mdx` and its JSON were generated by
`heldout/dataset/coverage/register.run.ts` for the development collection, under spec v7, with the v8.6.3 audit
and no verdict. Its per-country provenance cells include capability-probe rows, so they differ from section 1's
table where a probe source sits in the country.
