---
title: Release requirements v17 draft, three unread collections and the whole-street US scorer
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v17 draft, three unread collections and the whole-street US scorer

Status: **draft, unregistered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v17.json`
is v16 with a new confirmation role and the scorer revision of #3518. `release/current-spec.ts` still names v13.
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
| confirmation | `heldout-confirm-v0.8.22b`, `-capabilities`, `-probes` | `heldout-reserve-v0.8.22@b2a259ef6bcba5b4`, `heldout-confirm-v0.8.24-capabilities@f6826932eac0497b`, `heldout-confirm-v0.8.24-probes@82c44d978e64c55b` |
| scorer       | `69fbaf01c`                                            | `24d48aec5c`                                                                                                                                           |
| candidate    | v8.12.0                                                | empty until a candidate reads it                                                                                                                       |

## 3. The collections

| Collection                             |   Rows | How it was drawn                                                                                                                                   | Overlap audit against v0.8.22 and v0.8.23               |
| -------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `heldout-reserve-v0.8.22`              | 20,500 | 400 groups per country and row kind in the nine objective countries (seed 2216), held out of training by `evaluation-groups.v0.8.24`               | 19,219 `verified_unseen`, 1,281 `known_overlap` by text |
| `heldout-confirm-v0.8.24-capabilities` |  4,200 | `sub-venue` (seed 2275) and `country-balanced` (seed 2276) renders, filtered against every split of both corpora, 600 rows per country (seed 2277) | 4,200 `verified_unseen`                                 |
| `heldout-confirm-v0.8.24-probes`       |  5,000 | `heldout/probes/build.run.ts`, render seed 2271, confirmation seed 2273                                                                            | 5,000 `verified_unseen`                                 |

Each audit read configs v8.10.0, v8.13.0 and v8.12.0. The comparative checks admit only `verified_unseen` rows.
`evaluation-groups.v0.8.22-reserve` lists an earlier reserve draw, `681f928c68575cc3`, which is kept under
`/mnt/mw/corpus/heldout/superseded/`; v17 pins the file on disk, and the audit classes its rows. The outputs and the
render, filter and pool scripts are under `/mnt/mw/audits/v17-confirm/`.
