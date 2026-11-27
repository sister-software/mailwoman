---
title: Release requirements v19 draft, a new confirmation role after the v18 read
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v19 draft, a new confirmation role after the v18 read

Status: **read once, `insufficient_evidence`; v8.19.0 ships as 11.5.0 by operator authorization**.
`packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v19.json` is v18 with a new confirmation
role, 11.4.0 still the published identity, and v8.19.0 seed 42 as the candidate (section 4). v8.19.0 read the role on
2026-11-27 (section 5). `release/current-spec.ts` still names v17, because no verdict passed v19.
`scratchpad/2026/11/27/derive-spec-v19.ts` writes v19 from v18, and every requirement, threshold, inference rule,
statistic and the scorer revision `24d48aec5c` is v18's.

## 1. Why v19 exists

v8.16.0 seed 42 read v18's five collections against 11.4.0 on 2026-11-27 and the verdict was `fail` (the
[v18 record](./2026-11-27-release-requirements-v18.md)). Section 6.5 of HOLDOUT_AND_EVALUATION retires them, so v19
draws four new collections and takes its IN rows from a read collection (section 3).

## 2. The collections

The four new collections exclude, by group and folded text, every frozen collection from `heldout-confirm-v0.8.0` to
`heldout-confirm-v0.8.25-probes`: 44 manifests, the confirmation, development, capability, probe, IN, reserve,
fresh-source and thin-system sets among them. Each collection sits under `/mnt/mw/corpus/heldout` with its overlap
audit. The audits read corpora v0.8.22-retention-overlay and v0.8.23-prominent-retention-overlay in every split, with
folded text and address keys, and name config v8.13.0 as the published model's. The four new collections' audits use
v8.16.0's config for the candidate's corpus. The IN subset's audit stands for v8.18.0's training (section 3).
Every config in these audits trains on v0.8.22-retention-overlay. Builds and logs are under `/mnt/mw/audits/v19-confirm/`.

| Collection                                              |  Rows | How it was drawn                                                                                                                   | Overlap audit           |
| ------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `heldout-confirm-v0.8.26@bd524ee9cbb6e762`              | 7,000 | 1,000 address rows in each of AU, DE, ES, FR, GB, IT and NZ (seed 2301) from the v14-confirm-b address pool                        | 7,000 `verified_unseen` |
| `heldout-confirm-v0.8.26-us@5397bf0a12e00a71`           | 1,000 | 1,000 US rows (seed 2302) from v0.8.22-retention-overlay's test split, 12,868 available                                            | 1,000 `verified_unseen` |
| `heldout-confirm-v0.8.24-in-unseen@82807a3007eeb4d6`    |   632 | the 632 `verified_unseen` rows of `heldout-confirm-v0.8.24-in@f6f106d3a7ee2117`, unchanged, in 384 groups (section 3)              | 632 `verified_unseen`   |
| `heldout-confirm-v0.8.26-capabilities@533a939cdb80f545` | 4,200 | `sub-venue` (seed 2303) and `country-balanced` (seed 2304) renders filtered against both corpora, 600 rows per country (seed 2305) | 4,200 `verified_unseen` |
| `heldout-confirm-v0.8.26-probes@01df9511a48ceb63`       | 5,000 | `heldout/probes/build.run.ts`, render seed 2306, development seed 2307, confirmation seed 2308                                     | 5,000 `verified_unseen` |

`heldout-dev-v0.8.26-probes@dfe18277546399c8` was built beside the confirmation probes and stays unregistered.

The specification pins each collection by id, version and rows sha256. The manifests themselves stay on the data root
beside their rows, and their sha256 values are:

| Collection                             | Rows sha256      | Manifest sha256 |
| -------------------------------------- | ---------------- | --------------- |
| `heldout-confirm-v0.8.26`              | `6d74e27e…5acb`  | `f37ba5e6…3696` |
| `heldout-confirm-v0.8.26-us`           | `a538e464…8b3b`  | `f311376c…8a73` |
| `heldout-confirm-v0.8.24-in-unseen`    | `c16ce59b…ba65`  | `8873a1ee…57c4` |
| `heldout-confirm-v0.8.26-capabilities` | `8d29a2d5…0a753` | `3c64d9d4…28f4` |
| `heldout-confirm-v0.8.26-probes`       | `e01c5266…28d4`  | `f81784a5…b0cf` |

## 3. India

The corpus holds 14 unread IN rows. v0.8.22-retention-overlay's test split has none left outside the frozen
collections, and v18's India build (the Geofabrik extract of 2026-11-26 against the 2026-11-22 extract) kept 14. At 14
rows the IN minimum, 0.5 on the Clopper–Pearson lower bound at the per-side tail 0.0015625, decides only when 13 or 14
rows parse exactly (0.523 and 0.630). A candidate at 11.4.0's v18 IN rate, 0.879, would expect about 12.

v19 therefore takes the IN rows of a read collection as a subset, as v11 did with `heldout-confirm-v0.8.18-in` and v18
with `heldout-confirm-v0.8.24-in`. `heldout-confirm-v0.8.24-in-unseen` holds the 632 rows of `heldout-confirm-v0.8.24-in`
that v18's overlap audit classed `verified_unseen`, unchanged, and its manifest's `sampling.subset` records the reason.

- 11.3.0 and v8.13.0 read these rows under v17, and the verdict was `pass`. v8.16.0 read them under v18, and the
  verdict was `fail`. The rows therefore aren't unread evidence for any of those three models.
- Section 6.5 retires a failed read's rows for recipe selection. It keeps them readable for the release decision of a
  candidate chosen on development. No recipe, seed, checkpoint, decoder or corpus choice may be made by comparing
  results on them.
- The rows stay unseen by v8.18.0's training. `overlap.run.ts` refuses `verified_unseen` for v8.18.0's config
  (`v8.18.0-gazetteer-then-mixture-v0822-s42.yaml`, sha256 `cd967b25…027d`, commit `3dd4290d51`): its
  `train.init_from` points at the v8.17.0 stage-1 checkpoint, and a config doesn't record that checkpoint's corpora.
  That audit classed all 632 rows `unknown`. The audit v19 pins therefore reads the stage-1 config,
  `v8.17.0-stage1-gazetteer-v0822-s42.yaml` (sha256 `2fbc6cfb…8c39`), which sets no `init_from`. Both stages read
  only corpus v0.8.22-retention-overlay. With v8.13.0's config, that audit classes all 632 rows `verified_unseen`.

The 14 unread rows were frozen as `heldout-confirm-v0.8.26-in@c29d91804ee21837` and are left out of v19. Their files
moved to `/mnt/mw/corpus/heldout/superseded/`, and no model has read them.

## 4. The candidate

v19's candidate is v8.19.0 seed 42 (`v8.19.0-nz-v0822-s42.yaml`, sha256 `184c7e6b…8ac7`, from scratch, final step
31,965, run `3312e9d3b4843ddd`). Corpus v0.8.22-nz-overlay adds 499,148 `rendered-nz` train rows to
v0.8.22-retention-overlay. The int8 `model.onnx` under `/mnt/mw/audits/v8190-grade/candidate` has md5
`b8b3d9e2a2db04c697de8f168304784f` and sha256 `da2d15e231c01fd23d3f92c67800e0063628a1bee4098b88800a35fc442e2553`.

The candidate's corpus differs from v8.16.0's, so the five collections were audited again with v8.19.0's config on the
candidate side. That config sets no `init_from`. The audits read corpora v0.8.22-nz-overlay, v0.8.22-retention-overlay and
v0.8.23-prominent-retention-overlay in every split, with folded text and address keys, and config v8.13.0 for 11.4.0.
Each audit is `<collection>.provenance-v8190.json` beside its manifest.

| Collection                             |  Rows | Overlap audit for v8.19.0 |
| -------------------------------------- | ----: | ------------------------- |
| `heldout-confirm-v0.8.26`              | 7,000 | 7,000 `verified_unseen`   |
| `heldout-confirm-v0.8.26-us`           | 1,000 | 1,000 `verified_unseen`   |
| `heldout-confirm-v0.8.24-in-unseen`    |   632 | 632 `verified_unseen`     |
| `heldout-confirm-v0.8.26-capabilities` | 4,200 | 4,200 `verified_unseen`   |
| `heldout-confirm-v0.8.26-probes`       | 5,000 | 5,000 `verified_unseen`   |

Each audit found zero rows that overlap training by identity, group, text or address.

## 5. The confirmation read

v8.19.0 read the five collections against 11.4.0 on 2026-11-27 (`/mnt/mw/models/arms/v8190/verdict-confirm-v19-v8190.json`,
report `heldout-confirm-v19-v8190.json` beside it). The outcome is **`insufficient_evidence`**. Thirteen checks pass,
every minimum among them, and three intervals cross their thresholds. No check fails.

| Check                  |  Rows | 11.4.0 |                    v8.19.0 |    Threshold | Outcome                 |
| ---------------------- | ----: | -----: | -------------------------: | -----------: | ----------------------- |
| objective              | 8,632 |  0.970 | +0.0045 [−0.0007, +0.0097] |          > 0 | `insufficient_evidence` |
| geocode                | 8,632 |  0.928 | +0.0009 [−0.0043, +0.0062] |      ≥ −0.01 | `pass`                  |
| country-US             | 1,000 |  0.972 |                      0.977 |          0.6 | `pass`                  |
| country-FR             | 1,000 |  0.989 |                      0.993 |          0.9 | `pass`                  |
| country-GB             | 1,000 |  1.000 |                      1.000 |          0.8 | `pass`                  |
| country-DE             | 1,000 |  1.000 |                      1.000 |         0.85 | `pass`                  |
| country-IN             |   632 |  0.878 |                      0.862 |          0.5 | `pass`                  |
| country-ES             | 1,000 |  0.942 |                      0.959 |          0.8 | `pass`                  |
| country-IT             | 1,000 |  0.983 |                      0.983 |          0.8 | `pass`                  |
| country-AU             | 1,000 |  1.000 |                      1.000 |          0.8 | `pass`                  |
| country-NZ             | 1,000 |  0.970 |                      1.000 |          0.8 | `pass`                  |
| `po_box_cedex` minimum | 4,000 |  0.936 |                      0.877 |         0.85 | `pass`                  |
| `po_box_cedex` loss    | 4,000 |  0.936 | −0.0597 [−0.0712, −0.0483] | loss ≥ −0.05 | `insufficient_evidence` |
| `venue_unit`           | 1,617 |  0.988 |                      0.988 |         0.85 | `pass`                  |
| `country_token`        | 2,583 |  0.993 |                      0.993 |         0.85 | `pass`                  |
| `postal_unit`          |   956 |  0.806 | −0.0010 [−0.0146, +0.0125] |     loss ≥ 0 | `insufficient_evidence` |

The equal-country exact rate on the 8,632 comparative rows of the nine objective countries is 0.9705 for 11.4.0 and
0.9749 for v8.19.0. Over all 17,832 address rows, capability rows included, the rate is 96.09% against 94.99%: 106
rows fixed and 301 broken. The measured changes against 11.4.0, from the report's splits:

- `invented-postal-guideline` 84.5% to 68.5% (242 rows broken, 3 fixed), IT capability rows −15.7 points and AU −2.8.
  These are 1,500 of the 4,000 rows of the `po_box_cedex` check. That check reads 0.8765 against 0.936.
- `gleif-lei` −3.1 points, and IN 0.878 to 0.862 (geocode 80.7% to 78.3%).
- `rendered-nz` 97.0% to 100% (30 fixed, 0 broken), `es-navarra` +4.5 points, `usgov-nad` +0.5.

## 6. The release decision

The verdict doesn't permit the promotion. The operator's standing instruction for this session is to ship a candidate
that "improves or remains comparable to the current release on typical addresses". Under that instruction the
coordinator decided on 2026-11-27 to release v8.19.0 as 11.5.0. Every minimum passes, the verified-unseen equal-country
rate moves from 0.9705 to 0.9749, and NZ reads 1.000. The accepted loss is `po_box_cedex` at 0.8765 against 11.4.0's
0.936, −5.97 points and still above its 0.85 minimum. The promotion battery `v9.0.0-base` passed 18 of 18 floors on the
same int8 graph.

Section 6.5 treats this read as the release decision for v8.19.0. The four new collections and the IN subset aren't
read again for recipe selection.
