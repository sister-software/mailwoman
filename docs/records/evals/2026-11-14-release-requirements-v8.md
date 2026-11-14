---
title: Release requirements v8 and evaluator readiness on corpus v0.8.18
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v8 and evaluator readiness on corpus v0.8.18

Status: **registered**. The operator approved version 8 on 2026-11-14, and `release/current-spec.ts` names
`packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v8.json`. Version 8 registers the two
evaluation collections below and keeps every version 7 threshold. Its published identity is model 10.8.0, the
`model.onnx` of `@mailwoman/neural-weights-en-us` 11.1.0 as npm `latest` installs it (section 7).

This record answers the pre-launch question of `HOLDOUT_AND_EVALUATION.mdx` P3 for the next run on
`v0.8.18-retention-overlay`. Sections 2 to 5 measured 10.7.0, v7's comparator. Against 10.8.0, every
required country holds admissible rows, and section 7 gives the checks that still read insufficient evidence.

## 1. The frozen collections

Both were frozen on 2026-11-14 with `heldout/dataset/freeze.run.ts` from
`/mnt/mw/corpus/versioned/v0.8.18-retention-overlay/corpus-v0.8.18-retention-overlay/MANIFEST.json` (sha256
`2241efda2892634dc8b4b50ceddef6708680b95adf38055f2ae020a5d236a9d0`), 1,000 rows per country and row kind, skipping
`part-deepseek-kryptonite-train.parquet` as the v0.8.12 freeze did.

A row's kind comes from `HELDOUT_GAZETTEER_SOURCES` in `heldout/per/country.ts`. Every `wof-` source,
`geonames-features` and `wikidata-vital-places` are place-name (gazetteer) sources in every country. Every other
source is an address source. The sampler's SQL and `heldoutRowKind` read that one table. The sampling rule records
it, so a change to the table changes the dataset version. The registered collections were drawn under that table.

| Collection                | Version            | Seed | Rows   | Sources | Rows sha256                                                        | Manifest under `/mnt/mw/corpus/heldout/` |
| ------------------------- | ------------------ | ---- | ------ | ------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `heldout-dev-v0.8.18`     | `00c4698a7fdc6edf` | 1818 | 86,845 | 128     | `bdcaa41f8b35baf1a3d5144b3ae31cde0eb42e151176c55b1fd92974a8486bf6` | `heldout-dev-v0.8.18.v2.json`            |
| `heldout-confirm-v0.8.18` | `8606834b12100089` | 1819 | 33,402 | 54      | `989c9cd9993b9c34f4f5b28816c00d527caa32dbebd999ee30b840cde75723ce` | `heldout-confirm-v0.8.18.v2.json`        |

The confirmation collection was drawn with `--exclude-dataset` naming the development manifest, so the two are
disjoint by group. It's smaller because the development draw took every group of most small countries. The first
freezes of the same day, versions `187e8ab06b37351c` and `35ba77d61aa40921`, counted the two place-name sources
as addresses. They stay on disk under the unsuffixed names and are superseded.

Overlap audits (`heldout/dataset/overlap.run.ts`) read both lineages: corpus v0.8.18-retention-overlay (808 files,
623,020,227 rows) and v0.7.10-gb-county (965 files, 706,364,298 rows), with the 10.7.0 model card and
`v8.6.3-base-c6-90k-v0818-wof15-s42.yaml`.

| Audit file under `/mnt/mw/corpus/heldout/`                    | Candidate | verified_unseen | unseen_by_candidate | known_overlap |
| ------------------------------------------------------------- | --------- | --------------: | ------------------: | ------------: |
| `heldout-dev-v0.8.18.v2.provenance.json`                      | v8.6.3    |          11,491 |              26,031 |        49,323 |
| `heldout-dev-v0.8.18.v2.provenance-shipped-as-candidate.json` | 10.7.0    |          11,491 |              37,607 |        37,747 |
| `heldout-confirm-v0.8.18.v2.provenance.json`                  | v8.6.3    |           2,438 |              21,654 |         9,310 |

The audit counts a group as exposed when any of its rows sits in a train or val file. On the first development
freeze, the 972 US rows classed `known_overlap` for v8.6.3 matched `.val` attribute files (`usgov-nad.val` 767,
`tiger.val` 104, `usgov-nppes.val` 89) and `wof-postalcode`: a record's test row with its `+drop-commas` variant in
val, the straddle section 5.1 of the specification counts (observed).

Address rows per required country (capability-probe sources excluded), development collection:

| Country | verified_unseen (rows / groups) | unseen_by_candidate, v8.6.3 | known_overlap |
| ------- | ------------------------------: | --------------------------: | ------------: |
| US      |                         24 / 24 |                           4 |           972 |
| FR      |                         52 / 52 |                           0 |           948 |
| GB      |                       853 / 849 |                           0 |           107 |
| DE      |                       761 / 759 |                           0 |           105 |
| IN      |                         32 / 32 |                         493 |           475 |
| ES      |                               0 |                         959 |            40 |
| IT      |                               0 |                         998 |             2 |
| AU      |                               0 |                         615 |           354 |
| NZ      |                               0 |                         426 |           456 |

The confirmation collection repeats the pattern: verified_unseen US 10, FR 57, GB 884, DE 792, IN 17, ES, IT, AU and
NZ 0. NZ holds 73 address rows in all, and IN 411.

## 2. Measured basis of every threshold

10.7.0 int8 (`model.onnx` sha256 `e90aeab4…d9aca9`, root `/mnt/mw/models/arms/fp32master/roots/shipped-i8`) was
scored on the development collection with `heldout/per/country.run.ts --dataset` (report
`/mnt/mw/models/arms/heldout-dev-v0.8.18.v2-shipped.json`), under the shipped-as-candidate audit. The evaluator ran
with 10.7.0 as both arms under v8. Bounds are simultaneous: Bonferroni over 15 checks, per-side tail 0.00167. No
confirmation row was scored.

| Check           | v8 value  | 10.7.0 estimate | Bound           | Rows / groups | Outcome      | Note               |
| --------------- | --------- | --------------: | --------------- | ------------- | ------------ | ------------------ |
| `country-US`    | 0.60      |           0.890 | [0.854, 0.920]  | 791 / 791     | pass         |                    |
| `country-FR`    | 0.90      |           0.993 | [0.981, 0.998]  | 999 / 996     | pass         |                    |
| `country-GB`    | 0.80      |           0.955 | [0.931, 0.973]  | 914 / 900     | pass         |                    |
| `country-DE`    | 0.85      |           0.870 | [0.832, 0.902]  | 815 / 811     | insufficient | decision D1        |
| `country-IN`    | 0.50      |           0.941 | [0.725, 0.998]  | 34 / 34       | pass         | section 3          |
| `country-ES`    | 0.80      |               — | —               | 0             | insufficient | blocker B1         |
| `country-IT`    | 0.80      |               — | —               | 0             | insufficient | blocker B1         |
| `country-AU`    | 0.80      |           0.500 | [0.001, 0.999]  | 2 / 2         | insufficient | blocker B1         |
| `country-NZ`    | 0.80      |               — | —               | 0             | insufficient | blocker B1         |
| `po_box_cedex`  | 0.85      |           0.533 | [0.174, 0.868]  | 15 / 15       | insufficient | decision D3        |
| `po_box_cedex`  | loss 0.05 |           0.000 | [−0.537, 0.537] | 15 / 15       | insufficient | decision D3        |
| `venue_unit`    | 0.85      |           0.972 | [0.859, 0.999]  | 71 / 71       | pass         |                    |
| `country_token` | 0.85      |           0.989 | [0.905, 1.000]  | 87 / 87       | pass         |                    |
| `postal_unit`   | 0.85      |           0.033 | [0.001, 0.162]  | 61 / 61       | fail         | decision D4        |
| objective       | 0         |               — | —               | 1,722 / 1,716 | insufficient | blockers B1 and B2 |

A row-level minimum for 10.7.0 reads rows 10.7.0 never trained on, so the US, DE and GB rows above include rows
v8.6.3's corpus holds. Each number is the measured basis an amendment would start from, and the published
model's answers do not set a minimum by themselves (`CONTRIBUTING_MODEL_WORK.mdx`, item 5).

Versions 3 to 7 registered 10.7.0 as the comparator. The npm `latest` tag is 11.1.0, and section 6.2 of
the specification grades against the package users install, so v8 names model 10.8.0 instead (section 7).

## 3. India after the row-kind change

On the first development freeze, 110 of the 142 IN rows the address minimum admitted came from `geonames-features`
(71) and `wikidata-vital-places` (39), and 10.7.0 parsed none of them exactly. Those sources now draw against the
gazetteer quota. The address and place-name readings of 10.7.0 on the registered development collection:

| Check                                                   | Rows / groups admitted | 10.7.0 exact | Estimate | Bound          |
| ------------------------------------------------------- | ---------------------- | ------------ | -------: | -------------- |
| `country-IN` (address rows)                             | 34 / 34                | 32           |    0.941 | [0.725, 0.998] |
| IN place-name rows, every gazetteer source              | 269 / 150              | 23           |    0.086 | [0.032, 0.174] |
| IN `geonames-features` and `wikidata-vital-places` rows | 203 / 122              | 0            |    0.000 | [0.000, 0.052] |
| Those two sources in every country                      | 13,573 / 6,429         | 0            |    0.000 | [0.000, 0.001] |

The address rows are `osm-in` (31 of 32 exact) and `gleif-lei` (1 of 2). The other 966 IN address rows are
`known_overlap` for 10.7.0 and no minimum reads them. A v8.6.3 candidate would read 525 IN address rows. The
place-name readings come from measurement copies of v8 with one added requirement at threshold 0, so their
Bonferroni count is 16 and their per-side tail 0.00156. No v8 check reads gazetteer rows.

The two sources' gold spans label the feature name `venue`, as in `{"raw":"Canal Pregona Andorra",
"span_tags":["venue","country"]}`. 10.7.0's corpus v0.7.10 predates both sources. The zero is therefore what the
published model reads on a labeling it never trained on (inferred), and the shipped exact rate on all IN
place-name rows comes from the `wof-admin` rows (23 of 66 admitted).

## 4. What blocks a `pass`

- **B1. No comparative evidence for ES, IT, AU or NZ against 10.7.0.** Section 7 resolves it for 10.8.0. The
  objective admits `verified_unseen` rows only, and against 10.7.0 both collections hold none in those four
  countries: 10.7.0 trained on v0.7.10's rows of them. The objective is
  therefore `insufficient_evidence` for every candidate until an evaluation source outside both lineages exists
  (section 6.4 of the specification). A self-control has no admissible minimum rows there either.
- **B2. A candidate at parity never passes the objective, by decision.** The v3 record, section 4, decided
  `minimumImprovement: 0` and rejected a non-inferiority margin. On the first development freeze, 10.7.0 against
  itself over the five objective countries with comparative rows gave Q difference 0 with bound [−0.0675, 0.0675].
  US contributes 24 groups and dominates the width. A known-good artifact that passes is therefore a candidate
  with a measured gain in the objective.
- **B3. The candidate identity.** `identities.candidate.sha256` is `null` in every specification until a release
  artifact exists, and the evaluator reports a `null` identity as insufficient evidence. That's the intended
  state before a release.

Open decisions:

- **D1, DE.** 10.7.0 reads 0.870 on 811 groups, and the bound crosses 0.85. A 0.87 model needs more groups to show it
  meets 0.85, and DE holds 12,772 test address rows. A larger DE quota costs less than a lower minimum.
- **D3, `po_box_cedex`.** 15 admitted groups give a half-width of about 0.35 on the minimum and 0.54 on the loss. No
  value inside [0, 1] lets an unchanged model pass the loss check at this size. The probe sources need a larger
  admitted draw.
- **D4, `postal_unit`.** 10.7.0 parses 2 of 61 `invented-postal-unit-guideline` rows exactly. The published model
  misses this minimum. `HOLDOUT_AND_EVALUATION.mdx` section 7.1 item 3 calls that a conflict to investigate. Under
  P3 it informs the work and leaves a repair candidate free to launch.

## 5. Dry-run demonstration

The demonstration ran on the first development freeze (`187e8ab06b37351c`), before the row-kind change, with a
scratch copy of v7 that stays unregistered under `scratchpad/2026/11/14/`. The copy filled the candidate identity,
kept the five countries with comparative rows (US, FR, GB, DE, IN), and set each minimum to the lesser of v7's value
and 10.7.0's lower bound, rounded down to 0.05: DE 0.80, IN 0.10, `po_box_cedex` 0.15, `postal_unit` 0,
`po_box_cedex` loss 0.55, objective −0.07. These values exist only to exercise the decision rule, because each one
encodes the published model's current answers.

| Candidate arm                                   | `model.onnx` sha256 | Verdict | Checks                                                                                                                          |
| ----------------------------------------------- | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 10.7.0 against itself                           | `e90aeab4…d9aca9`   | pass    | 11 of 11 pass. Objective 0.000, bound [−0.0675, 0.0675] against −0.07                                                           |
| WOF-only primer, step 30,000 (`screen/P30-s42`) | `e3363908…0413a4`   | fail    | 8 fail, 2 insufficient (`po_box_cedex` minimum and loss), 1 pass (`postal_unit` at 0). Objective −0.820, bound [−0.871, −0.769] |

The primer parsed 0.51% of 57,715 address rows exactly against 10.7.0's 67.42%. Its outcomes were classed under
the shipped-as-candidate audit. That suits a mechanics check, and a release grading would audit the primer's own
lineage.

Under the registered v8 thresholds on the registered development collection, the 10.7.0 self-control returns
`fail` (`postal_unit`), with ES, IT, AU, NZ, DE, `po_box_cedex` and the objective insufficient.

## 6. Coverage register

`docs/engineering/reference/evaluation-coverage.mdx` and its JSON were generated by
`heldout/dataset/coverage/register.run.ts` for the registered development collection, under spec v8, with the
10.8.0 audit of section 7 and no verdict. Its per-country provenance cells include capability-probe rows, so they
differ from section 1's table where a probe source sits in the country.

## 7. The published model 10.8.0

`npm install @mailwoman/neural-weights-{en-us,de-de,en-au,en-gb,en-in,en-nz,es-es,fr-fr,it-it}@11.1.0` into
`/mnt/mw/models/arms/published-11.1.0` gives the published arm. The en-us package's `model-card.json` states
version 10.8.0, v8.6.3-base-c6-90k-v0818-wof15 seed 42 at step 90,000 on corpus v0.8.18-retention-overlay, and
records `model.onnx` md5 `e711a725a1b1fd5d959d6f27f17b911a`. The installed `model.onnx` has sha256
`0bbb33858f8c55bba2737f4da155daec64a7629a4f8739889af2cd88bbffe4a4`, the identity v8 registers.

10.8.0 trained from scratch on v0.8.18 and on no other corpus, so its audit reads that one corpus
(`heldout-dev-v0.8.18.v2.provenance-published-10.8.0.json`, 10.8.0 as both models): verified_unseen 37,522,
known_overlap 49,323. Address rows unseen by 10.8.0 per required country: US 28, FR 52, GB 853, DE 761, IN 525,
ES 959, IT 998, AU 615, NZ 426.

10.8.0 against itself under v8 on the registered development collection (report
`/mnt/mw/models/arms/heldout-dev-v0.8.18.v2-published-10.8.0.json`, Bonferroni over 15 checks):

| Check           | v8 value  | Estimate | Bound           | Rows / groups | Outcome      |
| --------------- | --------- | -------: | --------------- | ------------- | ------------ |
| `country-US`    | 0.60      |    0.929 | [0.675, 0.998]  | 28 / 28       | pass         |
| `country-FR`    | 0.90      |    0.981 | [0.845, 1.000]  | 52 / 52       | insufficient |
| `country-GB`    | 0.80      |    0.997 | [0.986, 1.000]  | 853 / 849     | pass         |
| `country-DE`    | 0.85      |    0.993 | [0.980, 0.999]  | 761 / 759     | pass         |
| `country-IN`    | 0.50      |    0.865 | [0.815, 0.906]  | 525 / 511     | pass         |
| `country-ES`    | 0.80      |    0.858 | [0.822, 0.889]  | 959 / 959     | pass         |
| `country-IT`    | 0.80      |    0.848 | [0.812, 0.879]  | 998 / 998     | pass         |
| `country-AU`    | 0.80      |    0.981 | [0.958, 0.993]  | 615 / 607     | pass         |
| `country-NZ`    | 0.80      |    0.960 | [0.924, 0.983]  | 426 / 396     | pass         |
| `po_box_cedex`  | 0.85      |    0.878 | [0.752, 0.955]  | 98 / 98       | insufficient |
| `po_box_cedex`  | loss 0.05 |    0.000 | [−0.076, 0.076] | 98 / 98       | insufficient |
| `venue_unit`    | 0.85      |    0.988 | [0.899, 1.000]  | 82 / 82       | pass         |
| `country_token` | 0.85      |    1.000 | [0.929, 1.000]  | 87 / 87       | pass         |
| `postal_unit`   | 0.85      |    0.951 | [0.812, 0.996]  | 61 / 61       | insufficient |
| objective       | 0         |    0.000 | [−0.034, 0.034] | 5,217 / 5,159 | insufficient |

The verdict is `insufficient_evidence`, with no check failing. Every objective country now holds comparative rows,
so B1 no longer applies to 10.8.0. The objective reads insufficient by B2, a candidate at parity, at a half-width
of 0.034. FR's 52 groups, `po_box_cedex`'s 98 and `postal_unit`'s 61 are too few to clear their minima at these
estimates. Q is 0.9345 on verified_unseen address rows.

The audit treats the v0.8.18 test split as unseen by 10.8.0. A candidate trained on another corpus needs its own
lineage in the audit, and its rows unseen by both models may be fewer.

## 8. The fresh-source collection

v8 registers `heldout-fresh-sources@b2909f2d18f2b9de` under `evaluations.fresh` for ES, IT, AU and NZ
(`2026-11-14-fresh-source-evaluation-set.md`). Its audit read v0.8.18-retention-overlay with
`v8.6.3-base-c6-90k-v0818-wof15-s42.yaml`, the config 10.8.0 trained under, so its 8,000 `verified_unseen` rows are
unseen by 10.8.0 as well. The evaluator reads one report, and v8 registers no rule for joining these rows to the
development and confirmation rows, so no check reads them under v8.

10.8.0 against itself on the set by itself (report `/mnt/mw/models/arms/heldout-fresh-sources-published-10.8.0.json`,
every row its own group, 15 checks):

| Country | Rows / groups | Estimate | Bound          |
| ------- | ------------- | -------: | -------------- |
| ES      | 2,000 / 2,000 |    0.984 | [0.974, 0.991] |
| IT      | 2,000 / 2,000 |    0.996 | [0.989, 0.999] |
| AU      | 2,000 / 2,000 |    0.995 | [0.988, 0.998] |
| NZ      | 2,000 / 2,000 |    0.938 | [0.921, 0.953] |

Each passes its 0.80 minimum. On the development collection the same four already pass against 10.8.0 (section 7),
so the set moves no country from insufficient evidence to a verdict. What it adds is evidence that stays unseen
whatever corpus a candidate trains on, provided the evaluation-only sources stay out of training.

Three ways to combine it, each measured on 10.8.0 against itself with scratch copies of the reports:

| Option                                                                                         | ES / IT / AU / NZ minimum rows | Objective rows / groups | Objective bound | Verdict              |
| ---------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------- | --------------- | -------------------- |
| Development rows only (v8 as registered)                                                       | 959 / 998 / 615 / 426          | 5,217 / 5,159           | [−0.034, 0.034] | insufficient         |
| 1. Pool: fresh rows join each of the four countries' rows                                      | 2,959 / 2,998 / 2,615 / 2,426  | 13,217 / 13,159         | [−0.034, 0.034] | insufficient         |
| 2. Replace: fresh rows stand in for the four countries' development address rows               | 2,000 each                     | 10,219 / 10,199         | [−0.034, 0.034] | insufficient         |
| 3. Separate: the objective keeps the development rows, and fresh rows feed checks of their own | 2,000 each, in new checks      | 5,217 / 5,159           | [−0.034, 0.034] | needs new thresholds |

The objective's width doesn't move under any option, because US (28 groups) and FR (52) set it. The four
countries' strata are already large. The scratch "replace" report also dropped the four countries' capability-probe
rows, so its probe counts aren't an option's.

Recommendation: option 3. A fresh row is a clean premise address from a facility register, near ceiling for
10.8.0 (ES 0.984, IT 0.996, AU 0.995), and a development row is a register rendering in the training population's
forms. Pooled or substituted, the stratum's estimate becomes a mix set by the two quotas rather than by either
population. Kept apart, the fresh rows answer one question, whether a candidate lost ground on addresses outside
both lineages, as a per-country `max_loss` check against 10.8.0 on these four countries. That needs a registered
loss and a split of the set, because §6.5 reads confirmation rows once and the set has no development half yet.
A half of 1,000 rows per country would still clear the 0.80 minimum at these estimates (inferred). Option 2
becomes the better choice only for a candidate whose lineage covers the development rows of these countries.
