---
title: Release requirements v18, five unread collections and the v8.16.0 read
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v18, five unread collections and the v8.16.0 read

Status: **read once, `fail`**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v18.json` is
v17 with a new confirmation role, 11.4.0 as the published identity and v8.16.0 seed 42 as the candidate. v8.16.0
read the role on 2026-11-27 and failed (section 3), so v18 doesn't become current: `release/current-spec.ts` still
names v17, and `register/candidate.run.ts` moves that path only when a change makes a new version current.
`scratchpad/2026/11/27/derive-spec-v18.ts` writes v18 from v17, and every requirement, threshold, inference rule,
statistic and the scorer revision `24d48aec5c` is v17's.

## 1. What changes from v17

| Field        | v17                                                   | v18                                                                                                                                      |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| confirmation | `heldout-confirm-v0.8.24`, `-capabilities`, `-probes` | `heldout-confirm-v0.8.25`, `heldout-confirm-v0.8.25-us`, `heldout-confirm-v0.8.24-in`, `heldout-confirm-v0.8.25-capabilities`, `-probes` |
| published    | 11.3.0, sha256 `ebd8af18…ece8`                        | 11.4.0, sha256 `6a4d585f…c6c3`                                                                                                           |
| candidate    | v8.13.0 seed 42                                       | v8.16.0 seed 42, step 126,000, run `95b25bbdc2ff04c7`, sha256 `98bda051…2313`                                                            |

## 2. The collections

Each sits under `/mnt/mw/corpus/heldout` with its overlap audit. The audits read corpora v0.8.22-retention-overlay
and v0.8.23-prominent-retention-overlay in every split, with folded text and address keys, and configs v8.13.0 and
v8.16.0. Builds, renders and logs are under `/mnt/mw/audits/v18-confirm/`.

| Collection                                              |  Rows | How it was drawn                                                                                                                   | Overlap audit                                                     |
| ------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `heldout-confirm-v0.8.25@86e2b27b24e2be1b`              | 7,000 | 1,000 address rows in each of AU, DE, ES, FR, GB, IT and NZ (seed 2281) from the v14-confirm-b address pool                        | 7,000 `verified_unseen`                                           |
| `heldout-confirm-v0.8.25-us@5f26b32b227c6073`           | 1,011 | v0.8.22-retention-overlay's test split with every frozen collection excluded (seed 2282): 1,000 US, 9 FR, 2 NZ                     | 1,011 `verified_unseen`                                           |
| `heldout-confirm-v0.8.24-in@f6f106d3a7ee2117`           |   637 | the IN address rows of `heldout-confirm-v0.8.24@eba875cf37531817`, unchanged                                                       | 632 `verified_unseen`, 3 `unseen_by_candidate`, 2 `known_overlap` |
| `heldout-confirm-v0.8.25-capabilities@8364a34c0e319e75` | 4,200 | `sub-venue` (seed 2294) and `country-balanced` (seed 2295) renders filtered against both corpora, 600 rows per country (seed 2296) | 4,200 `verified_unseen`                                           |
| `heldout-confirm-v0.8.25-probes@c2d85ef9bb51c6a0`       | 5,000 | `heldout/probes/build.run.ts`, render seed 2291, confirmation seed 2293                                                            | 5,000 `verified_unseen`                                           |

India: the Geofabrik India extract of 2026-11-26 against the 2026-11-22 extract v14 read gave 224 corpus rows, and 14
survived the filter against both corpora. That's too few for the IN minimum and the IN strata, so v18 took the IN rows of
`heldout-confirm-v0.8.24` as v11 took `heldout-confirm-v0.8.18-in`. 11.3.0 and v8.13.0 had read them once under v17.
That read passed. Section 6.5 of HOLDOUT_AND_EVALUATION retires only a failed read's rows. The manifest's `sampling.subset` records
the reason. The 14 rows weren't frozen.

## 3. The confirmation read

v8.16.0 (`v8.16.0-base-c6-wofreps-positions-v0822-s42.yaml` seed 42, step 126,000, run `95b25bbdc2ff04c7`, corpus
v0.8.22-retention-overlay, int8 `model.onnx` md5 `166dbc7175f129adcef42fe138386304`) read the five collections against
11.4.0 on 2026-11-27 (`/mnt/mw/models/arms/v8160/verdict-confirm-v18-v8160.json`, report
`heldout-confirm-v18-v8160.json` beside it). The outcome is **`fail`**: 13 checks pass, `objective` and
`postal_unit` fail, and `geocode` is insufficient evidence.

| Check                  |  Rows | 11.4.0 |                    v8.16.0 |    Threshold | Outcome                 |
| ---------------------- | ----: | -----: | -------------------------: | -----------: | ----------------------- |
| objective              | 8,631 |  0.970 | −0.0083 [−0.0143, −0.0023] |          > 0 | `fail`                  |
| geocode                | 8,631 |  0.927 | −0.0108 [−0.0168, −0.0049] |      ≥ −0.01 | `insufficient_evidence` |
| country-US             |   999 |  0.962 |                      0.957 |          0.6 | `pass`                  |
| country-FR             | 1,000 |  0.989 |                      0.989 |          0.9 | `pass`                  |
| country-GB             | 1,000 |  0.999 |                      0.999 |          0.8 | `pass`                  |
| country-DE             | 1,000 |  1.000 |                      1.000 |         0.85 | `pass`                  |
| country-IN             |   635 |  0.879 |                      0.871 |          0.5 | `pass`                  |
| country-ES             | 1,000 |  0.939 |                      0.954 |          0.8 | `pass`                  |
| country-IT             | 1,000 |  0.983 |                      0.985 |          0.8 | `pass`                  |
| country-AU             | 1,000 |  1.000 |                      1.000 |          0.8 | `pass`                  |
| country-NZ             | 1,000 |  0.976 |                      0.897 |          0.8 | `pass`                  |
| `po_box_cedex` minimum | 4,012 |  0.937 |                      0.907 |         0.85 | `pass`                  |
| `po_box_cedex` loss    | 4,012 |  0.937 | −0.0299 [−0.0391, −0.0208] | loss ≥ −0.05 | `pass`                  |
| `venue_unit`           | 1,598 |  0.989 |                      0.989 |         0.85 | `pass`                  |
| `country_token`        | 2,602 |  0.991 |                      0.993 |         0.85 | `pass`                  |
| `postal_unit`          |   956 |  0.808 | −0.0241 [−0.0417, −0.0064] |     loss ≥ 0 | `fail`                  |

The measured losses against 11.4.0, from the report's splits over 17,843 `verified_unseen` address rows (96.03% exact for
11.4.0, 94.86% for v8.16.0, 84 rows fixed and 293 broken):

- `rendered-nz` 97.6% to 89.7% (84 broken), and the NZ geocode outcome 95.4% to 86.8%.
- `invented-postal-guideline` 84.6% to 77.1% (130 broken), AU capability rows −9.1 points and IT −2.1.
- `invented-postal-unit-guideline` −2.2 points, `po_box_cedex` −3.0 points.
- IN −0.8 points (geocode 80.7% to 78.7%), US −0.5, `gleif-lei` −0.9.

ES gained 1.5 points, `es-navarra` 4.2 of them. No cause was read from these rows.

## 4. What the read retires

Section 6.5 retires every collection a failed candidate read: `heldout-confirm-v0.8.25@86e2b27b24e2be1b`,
`heldout-confirm-v0.8.25-us@5f26b32b227c6073`, `heldout-confirm-v0.8.24-in@f6f106d3a7ee2117`,
`heldout-confirm-v0.8.25-capabilities@8364a34c0e319e75` and `heldout-confirm-v0.8.25-probes@c2d85ef9bb51c6a0`. No recipe,
seed, checkpoint, decoder or corpus choice may be made by comparing results on them. 11.5.0 doesn't ship v8.16.0.
