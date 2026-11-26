---
title: Release requirements v16 draft, the 11.3.0 comparator on v14's unread confirmation role
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v16 draft, the 11.3.0 comparator on v14's unread confirmation role

Status: **draft, unregistered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v16.json`
is v14 with its published identity moved to 11.3.0 and its candidate left empty. `release/current-spec.ts` still
names v13. v15 read v13's retired collections (`2026-11-26-release-requirements-v15.md`), so v16 is the first
specification whose confirmation role a release can read since 11.3.0 shipped.

## 1. What changes from v14

| Field                  | v14                                                                                                   | v16                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identities.published` | 11.2.0, `d51bb0ef…12b39f`                                                                             | 11.3.0, `model.onnx` sha256 `ebd8af18d8debee722b9488a44b7e9de132795c32cc78939355d149e924fece8` (the v8.10.0 graph, corpus `v0.8.22-retention-overlay`) |
| `identities.candidate` | empty                                                                                                 | empty                                                                                                                                                  |
| confirmation           | `heldout-confirm-v0.8.22b`, `heldout-confirm-v0.8.22b-capabilities`, `heldout-confirm-v0.8.22-probes` | unchanged                                                                                                                                              |

Every requirement, collection, scorer, inference rule and statistic is v14's, checked by comparing the two files key
by key (`scratchpad/2026/11/26/derive-spec-v16.ts`).

## 2. Why v14's confirmation role is readable

The three collections were drawn on 2026-11-22 from rows no corpus held. Their provenance audits against 11.2.0 and
v8.10.0 sit beside them under `/mnt/mw/corpus/heldout/` (`*.provenance-11.2.0-v8.10.0.json`). v8.10.0's grading read
only the development collections (`/mnt/mw/models/arms/v8100/reads/`), and no release read of v14 is recorded.

## 3. Before a candidate reads it

The next candidate trains on corpus `v0.8.23-prominent-retention-overlay`, which adds sources v0.8.22 lacked, among
them `overture-places-in`. An overlap audit of the three collections against v0.8.21, v0.8.22 and v0.8.23
(`heldout/dataset/overlap.run.ts --match-text --match-address`) runs before the read, and the candidate's sha256 is
written into `identities.candidate` from its export.
