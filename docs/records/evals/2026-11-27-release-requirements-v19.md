---
title: Release requirements v19 draft, five unread collections after the v18 read
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v19 draft, five unread collections after the v18 read

Status: **draft, unregistered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v19.json` is
v18 with a confirmation role no model has read, 11.4.0 still the published identity, and an empty candidate identity
for the next candidate to fill. `release/current-spec.ts` still names v17. `scratchpad/2026/11/27/derive-spec-v19.ts`
writes v19 from v18, and every requirement, threshold, inference rule, statistic and the scorer revision `24d48aec5c`
is v18's. No model has scored these collections.

## 1. Why v19 exists

v8.16.0 seed 42 read v18's five collections against 11.4.0 on 2026-11-27 and the verdict was `fail` (the
[v18 record](./2026-11-27-release-requirements-v18.md)). Section 6.5 of HOLDOUT_AND_EVALUATION retires them, so v19
draws five new ones.

## 2. The collections

Each collection excludes, by group and folded text, every frozen collection from `heldout-confirm-v0.8.0` to
`heldout-confirm-v0.8.25-probes`: 44 manifests, the confirmation, development, capability, probe, IN, reserve,
fresh-source and thin-system sets among them. Each sits under `/mnt/mw/corpus/heldout` with its overlap audit. The
audits read corpora v0.8.22-retention-overlay and v0.8.23-prominent-retention-overlay in every split, with folded text
and address keys. They name config v8.13.0 as the published model's. v8.16.0's config stands in for the candidate's,
because the next candidate, v8.18.0, trains on the same corpus. Builds and logs are under `/mnt/mw/audits/v19-confirm/`.

| Collection                                              |  Rows | How it was drawn                                                                                                                   | Overlap audit           |
| ------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `heldout-confirm-v0.8.26@bd524ee9cbb6e762`              | 7,000 | 1,000 address rows in each of AU, DE, ES, FR, GB, IT and NZ (seed 2301) from the v14-confirm-b address pool                        | 7,000 `verified_unseen` |
| `heldout-confirm-v0.8.26-us@5397bf0a12e00a71`           | 1,000 | 1,000 US rows (seed 2302) from v0.8.22-retention-overlay's test split, 12,868 available                                            | 1,000 `verified_unseen` |
| `heldout-confirm-v0.8.26-in@c29d91804ee21837`           |    14 | the 14 OSM India rows of v18's India build that no corpus split holds (seed 2309)                                                  | 14 `verified_unseen`    |
| `heldout-confirm-v0.8.26-capabilities@533a939cdb80f545` | 4,200 | `sub-venue` (seed 2303) and `country-balanced` (seed 2304) renders filtered against both corpora, 600 rows per country (seed 2305) | 4,200 `verified_unseen` |
| `heldout-confirm-v0.8.26-probes@01df9511a48ceb63`       | 5,000 | `heldout/probes/build.run.ts`, render seed 2306, development seed 2307, confirmation seed 2308                                     | 5,000 `verified_unseen` |

`heldout-dev-v0.8.26-probes@dfe18277546399c8` was built beside the confirmation probes and stays unregistered.

The specification pins each collection by id, version and rows sha256. The manifests themselves stay on the data root
beside their rows, and their sha256 values are:

| Collection                             | Rows sha256      | Manifest sha256 |
| -------------------------------------- | ---------------- | --------------- |
| `heldout-confirm-v0.8.26`              | `6d74e27e…5acb`  | `f37ba5e6…3696` |
| `heldout-confirm-v0.8.26-us`           | `a538e464…8b3b`  | `f311376c…8a73` |
| `heldout-confirm-v0.8.26-in`           | `25ba5289…eab7`  | `cce43c60…af3c` |
| `heldout-confirm-v0.8.26-capabilities` | `8d29a2d5…0a753` | `3c64d9d4…28f4` |
| `heldout-confirm-v0.8.26-probes`       | `e01c5266…28d4`  | `f81784a5…b0cf` |

## 3. India

The corpus holds 14 unread IN rows. v0.8.22-retention-overlay's test split has none left outside the frozen
collections: the US draw found US rows only. v18's India build (the Geofabrik extract of 2026-11-26 against the
2026-11-22 extract) kept 14 rows, and v18 didn't freeze them, so `heldout-confirm-v0.8.26-in` holds those 14.

The IN minimum is 0.5 on the Clopper–Pearson lower bound at the per-side tail 0.0015625, the Bonferroni tail over 16
checks. At 14 rows in 14 groups the bound reaches 0.5 only when 13 or 14 rows parse exactly (0.523 and 0.630).
A candidate at 11.4.0's v18 IN rate, 0.879, would expect about 12, so the check would read
`insufficient_evidence`, and so would the verdict. The IN stratum of the objective and the geocode check reads 14 units.

The requirements code accepts three ways forward:

1. Add the IN rows of a read collection as a subset, as v11 did with `heldout-confirm-v0.8.18-in` and v18 with
   `heldout-confirm-v0.8.24-in`. Section 6.5 retires a failed read's rows for recipe selection only, and keeps them
   readable for the release decision of a candidate chosen on development. `heldout-confirm-v0.8.24-in` has 632
   `verified_unseen` rows, and 11.3.0, v8.13.0 and v8.16.0 have read them.
2. Draw new IN rows outside both corpora: a newer Geofabrik extract against the 2026-11-26 one, through the v18 India
   build. That adds the objects mapped since 2026-11-26.
3. Keep the 14 rows and accept that the IN check decides only at 13 or more exact rows.

v19 as drafted takes the third. A change to the country minimum or to the objective's countries would change the
requirements, and v19 keeps v18's.
