---
title: Release requirements v12, a development collection unseen by 10.8.0 and by v0.8.21 candidates
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v12, a development collection unseen by 10.8.0 and by v0.8.21 candidates

Status: **registered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v12.json` is the
current specification, and `release/current-spec.ts` names it. It was registered before any model read
`heldout-dev-v0.8.21`.

## 1. What changes

V12 adds `heldout-dev-v0.8.21@7f9dcfb6572d4bf9` to the development role and keeps every other v11 value: each
requirement, the objective, the statistics, the provenance admission, the scorer, the inference rule, the published
identity, the confirmation role and `identities.dataset`. `identities.candidate.sha256` stays `null`. A candidate
that passes the development role is registered by v13, derived with `release/register/candidate.run.ts`.

| Role        | v11                                              | v12                                    |
| ----------- | ------------------------------------------------ | -------------------------------------- |
| development | `heldout-dev-v0.8.18@771811f7a5a8e4da`           | unchanged                              |
|             | `heldout-dev-v0.8.19-probes-r2@dd560a53b897dbca` | unchanged                              |
|             |                                                  | `heldout-dev-v0.8.21@7f9dcfb6572d4bf9` |

## 2. Why

Under the text-matching overlap audit (`overlap.run.ts --match-text`) against corpus v0.8.20, v11's development role
kept 426 US rows for comparison. v8.7.0 seed 42 and v8.8.0 seed 42 both read insufficient evidence on the geocode check
and the objective on it (observed on 2026-11-19, `/mnt/mw/models/arms/v880/verdict-dev-v11-*.json`).

## 3. The collection

`freeze.run.ts`, seed 1827, 4,000 rows per country and kind, from the test split of corpus
`v0.8.18-retention-overlay` (the rows 10.8.0 held out), with every read or registered collection excluded: 23
manifests, among them both confirmation collections, the IN supplement and every probe set. A first draw at 1,000 per
country gave 28 comparable US groups and was discarded unread.

The 10.8.0 audit with `--match-text` (`heldout-dev-v0.8.21.provenance-10.8.0.json`) classes 35,084 of 44,978 rows
`verified_unseen` and 9,894 `known_overlap`. Every US and FR overlap is a group whose other rendering 10.8.0 trained
on. Verified-unseen ordinary address groups:

| US  | FR  | GB  | DE    | IN  | ES    | IT    | AU  | NZ  |
| --- | --- | --- | ----- | --- | ----- | ----- | --- | --- |
| 96  | 193 | 0   | 3,038 | 0   | 3,756 | 3,987 | 730 | 0   |

The earlier collections took every test group of GB, IN and NZ, so `heldout-dev-v0.8.18` stays in the role for those
countries. The US and FR rows that remain are records 10.8.0 saw in no rendering, which may differ from the typical
record.

`evaluation-groups.v0.8.21.json` lists the collection's groups, and corpus `v0.8.21-retention-overlay`
(`MANIFEST.json` sha256 `5a9f26e5…199d1b`) records it among its evaluation datasets, so a candidate trained on v0.8.21
never sees these rows. v8.7.0 seeds 42 and 43 and v8.8.0 trained on them, so the collection grades no earlier arm.

## 4. Reads of v11

The development role was read on 2026-11-19 by 10.8.0, v8.7.0 seed 42 and v8.8.0 seed 42. No model read v11's
confirmation role.
