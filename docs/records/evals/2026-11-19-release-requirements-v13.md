---
title: Release requirements v13, the v8.9.0 seed 42 candidate
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v13, the v8.9.0 seed 42 candidate

Status: **registered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v13.json` is the
current specification, and `release/current-spec.ts` names it. `release/register/candidate.run.ts` derived it from v12.

## 1. What changes

V13 sets `identities.candidate` and keeps every other v12 value.

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| sha256      | `d51bb0efa5a61e5fc7233b94f0f7c9946be988100b230bc6b17c40808112b39f`                             |
| md5         | `75b1e6f6b4c7d85221091ab5ffa12063`                                                             |
| Run         | `65dfbda009d9ed2b`, config `v8.9.0-base-c6-90k-v0821-s42.yaml`, step 90,000                    |
| Corpus      | `v0.8.21-retention-overlay`, `MANIFEST.json` sha256 `5a9f26e5…199d1b`                          |
| Staged root | `/mnt/mw/models/arms/v890/roots/n890-42-i8`, a copy of `n880-42-i8` with `model.onnx` replaced |

## 2. The development choice

Under v12 the candidate's development verdict (`/mnt/mw/models/arms/v890/verdict-dev-v12-n890.json`) passes all 16
checks, and reads insufficient evidence only because the identity was unregistered. Objective +0.041
[+0.025, +0.057], geocode loss +0.038 [+0.022, +0.054], Bonferroni over 16 checks.

## 3. Reads of v12

The development role was read on 2026-11-19 by 10.8.0 and v8.9.0, with geocoding, and by v8.8.0 seed 42 and v8.7.0
seed 42, parses only, for row comparisons. Both of those trained on `heldout-dev-v0.8.21`. No model read the
confirmation role before v13.

## 4. Confirmation reads under v13

Section 6.5 of HOLDOUT_AND_EVALUATION records every confirmation read in the next version's rationale. The reads
under v13 are listed here as they happen and carried into v14.
