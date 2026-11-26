---
title: Release requirements v17, three unread collections and the whole-street US scorer
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v17, three unread collections and the whole-street US scorer

Status: **registered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v17.json`
is v16 with a new confirmation role and the scorer revision of #3518. `release/current-spec.ts` names v17, and its
candidate is v8.13.0 seed 42, which read the confirmation role on 2026-11-26 and passed (section 4).
`scratchpad/2026/11/26/derive-spec-v17.ts` writes it from v16, and every requirement, threshold, inference rule and
statistic is v16's.

## 1. The v16 read

v8.12.0 (run `87902e27f4fff9bc`, corpus `v0.8.23-prominent-retention-overlay`, `model.onnx` sha256
`ea9db85b3672c7550c34f90ee393ff36953371dd69b6403a12998176f9027b60`) read v16's three collections on 2026-11-26. The
verdict was `fail` on `country-US`, 0.151 against 0.6, and every other check passed. Section 6.5 of
HOLDOUT_AND_EVALUATION retires the three collections for every later candidate.

The US check read 1,000 `usgov-nppes` rows. Five US sources label the street as one `street` span, and both models
emit the split `docs/engineering/reference/SCHEMA.mdx` prescribes. The published 11.3.0 model also scores 151 of
1,000 there. #3518 changes the scorer to compare a US row joined when its gold labels no street affix. On the
development collections `usgov-nppes` moves from 46 to 443 of 451 rows for 11.3.0.

## 2. What changes from v16

| Field        | v16                                                    | v17                                                                                                                                                    |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| confirmation | `heldout-confirm-v0.8.22b`, `-capabilities`, `-probes` | `heldout-confirm-v0.8.24@eba875cf37531817`, `heldout-confirm-v0.8.24-capabilities@f6826932eac0497b`, `heldout-confirm-v0.8.24-probes@82c44d978e64c55b` |
| scorer       | `69fbaf01c`                                            | `24d48aec5c`                                                                                                                                           |
| candidate    | v8.12.0                                                | empty until a candidate reads it                                                                                                                       |

## 3. The collections

| Collection                             |   Rows | How it was drawn                                                                                                                                   | Overlap audit against v0.8.22 and v0.8.23               |
| -------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `heldout-confirm-v0.8.24`              | 15,638 | up to 1,000 rows per country and row kind (seed 2278) from v0.8.22's test groups outside every other frozen collection                             | 14,472 `verified_unseen`, 1,166 `known_overlap` by text |
| `heldout-reserve-v0.8.22`              | 20,500 | 400 groups per country and row kind in the nine objective countries (seed 2216), held out of training by `evaluation-groups.v0.8.24`; not pinned   | 19,219 `verified_unseen`, 1,281 `known_overlap` by text |
| `heldout-confirm-v0.8.24-capabilities` |  4,200 | `sub-venue` (seed 2275) and `country-balanced` (seed 2276) renders, filtered against every split of both corpora, 600 rows per country (seed 2277) | 4,200 `verified_unseen`                                 |
| `heldout-confirm-v0.8.24-probes`       |  5,000 | `heldout/probes/build.run.ts`, render seed 2271, confirmation seed 2273                                                                            | 5,000 `verified_unseen`                                 |

The first commit of v17 (`56c9e448cb`) pinned the reserve file itself. `release/evaluate.run.ts` refuses a reserve
(`collection.ts`: a reserve is never scored, and an evaluation collection is frozen from its groups). The grading run
of 2026-11-26 15:46 UTC scored the published model and v8.13.0 on the reserve's 20,500 rows before the verdict step
refused it. That run printed per-country exact rates, and no verdict was computed. v17 now pins
`heldout-confirm-v0.8.24@eba875cf37531817`: `freeze.run.ts --manifest` over v0.8.22-retention-overlay's test split,
`--per-country 1000 --seed 2278`, with every frozen collection but the reserve excluded. That leaves the reserve's
groups, 26,820 further US address rows and 9 CA rows in the pool. It holds 15,638 rows from 32 sources.

Each audit read configs v8.10.0, v8.13.0 and v8.12.0. The comparative checks admit only `verified_unseen` rows.
`evaluation-groups.v0.8.22-reserve` lists an earlier reserve draw, `681f928c68575cc3`, which is kept under
`/mnt/mw/corpus/heldout/superseded/`; v17 pins the file on disk, and the audit classes its rows. The outputs and the
render, filter and pool scripts are under `/mnt/mw/audits/v17-confirm/`.

## 4. The confirmation read

v8.13.0 (`v8.13.0-base-c6-wofreps-v0822-s42.yaml` seed 42, step 122,000, run `f339a83d401dd492`, corpus
v0.8.22-retention-overlay, int8 `model.onnx` sha256 `6a4d585fea59149748d01331fafa62018f1e2daad4001e7b9a1a57385dc1d6c3`)
read the three collections against 11.3.0 on 2026-11-26 at 16:29 UTC
(`/mnt/mw/models/arms/v8130/verdict-confirm-v17-n8130.json`). The outcome is `pass` on all 16 checks.

| Check           |  Rows | 11.3.0 |                 v8.13.0 |          Threshold |
| --------------- | ----: | -----: | ----------------------: | -----------------: |
| objective       | 7,481 |  0.940 | +0.014 [+0.005, +0.023] |                > 0 |
| geocode         | 7,481 |  0.914 | +0.005 [−0.001, +0.012] |            ≥ −0.01 |
| country-US      | 1,000 |  0.939 |                   0.961 |                0.6 |
| country-FR      |   996 |  1.000 |                   0.998 |                0.9 |
| country-GB      |   440 |  0.991 |                   0.989 |                0.8 |
| country-DE      |   971 |  0.952 |                   0.952 |               0.85 |
| country-IN      |   632 |  0.892 |                   0.878 |                0.5 |
| country-ES      |   867 |  0.953 |                   0.952 |                0.8 |
| country-IT      |   994 |  0.985 |                   0.984 |                0.8 |
| country-AU      |   715 |  0.965 |                   0.966 |                0.8 |
| country-NZ      |   866 |  0.788 |                   0.908 |                0.8 |
| `po_box_cedex`  | 4,064 |  0.883 |          0.939 (+0.056) | 0.85, loss ≥ −0.05 |
| `venue_unit`    | 1,637 |  0.984 |                   0.984 |               0.85 |
| `country_token` | 2,587 |  0.993 |                   0.991 |               0.85 |
| `postal_unit`   |   977 |  0.775 |                  +0.033 |           loss ≥ 0 |

The measured losses against 11.3.0 are IN −0.014, FR, GB and `country_token` −0.002, and ES and IT −0.001. Each is
inside its threshold.
