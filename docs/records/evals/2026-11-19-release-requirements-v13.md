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
under v13 are listed here as they happen and included in v14.

| Date       | Arms                                 | Collections                     | Verdict  |
| ---------- | ------------------------------------ | ------------------------------- | -------- |
| 2026-11-19 | 10.8.0 (baseline) and v8.9.0 seed 42 | all three v13 confirmation sets | **pass** |

This is the first read of `heldout-confirm-v0.8.20` and `heldout-confirm-v0.8.20-probes`, and 10.8.0's one baseline
scoring under v13. `heldout-confirm-v0.8.18-in` was read under v9 and v10 by 10.8.0 and v8.7.0 seeds 42 and 43, so its
IN rows are not unread evidence for 10.8.0.

The report ran 10:57–11:23 UTC from commit `6efb424d5c` with a clean tree, geocoded against
`/mnt/mw/db/wof/candidate-global-2026-11-19.db`, with the candidate's provenance from text-matching audits over
corpora `v0.8.18-retention-overlay` and `v0.8.21-retention-overlay`
(`/mnt/mw/models/arms/v890/provenance/heldout-confirm-*.provenance-v890.json`). Report
`/mnt/mw/models/arms/v890/heldout-confirm-v890.json`, verdict `/mnt/mw/models/arms/v890/verdict-confirm-v13-n890.json`,
whose candidate sha256 is the registered `d51bb0ef…12b39f`. Bonferroni over 16 checks:

| Check                  | Estimate [bound]        | Threshold |
| ---------------------- | ----------------------- | --------- |
| `country-US`           | 0.899 [0.867, 0.925]    | 0.60      |
| `country-FR`           | 0.996 [0.986, 1.000]    | 0.90      |
| `country-GB`           | 0.990 [0.946, 1.000]    | 0.80      |
| `country-DE`           | 0.995 [0.983, 0.999]    | 0.85      |
| `country-IN`           | 0.969 [0.933, 0.989]    | 0.50      |
| `country-ES`           | 0.978 [0.961, 0.990]    | 0.80      |
| `country-IT`           | 0.991 [0.978, 0.997]    | 0.80      |
| `country-AU`           | 0.982 [0.965, 0.992]    | 0.80      |
| `country-NZ`           | 0.995 [0.984, 0.999]    | 0.80      |
| `po_box_cedex` minimum | 0.908 [0.894, 0.921]    | 0.85      |
| `po_box_cedex` loss    | +0.069 [+0.057, +0.082] | −0.05     |
| `venue_unit`           | 0.985 [0.877, 1.000]    | 0.85      |
| `country_token`        | 0.990 [0.914, 1.000]    | 0.85      |
| `postal_unit` loss     | +0.054 [+0.031, +0.078] | 0         |
| `geocode` loss         | +0.073 [+0.053, +0.093] | −0.01     |
| objective              | +0.081 [+0.061, +0.101] | 0         |

Every check passes.
