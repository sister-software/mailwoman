---
title: Release requirements v15, a confirmation read of v8.11.0 on retired collections
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v15, a confirmation read of v8.11.0 on retired collections

Status: **unregistered, read once as a diagnostic**. `release/current-spec.ts` still names v13.
`packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v15.json` is v13 with its version, its
rationale and its two identities changed. Its confirmation role is therefore v13's three collections, which v13's
own read on 2026-11-19 retired (the v14 record, section 2). The v8.11.0 read below is a diagnostic, and the next
release-directed specification takes v14's unread confirmation role instead.

## 1. What changes from v13

| Field                  | v13                                                                                       | v15                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `identities.published` | 10.8.0, `0bbb3385…e4a4`                                                                   | 11.3.0, `model.onnx` sha256 `ebd8af18d8debee722b9488a44b7e9de132795c32cc78939355d149e924fece8` (the v8.10.0 graph) |
| `identities.candidate` | v8.9.0 seed 42, `d51bb0ef…12b39f`                                                         | v8.11.0 seed 42, run `c485e35de812c131`, sha256 `f556d00e9564bba5f1315df8c337a6425b3b621291ae7976f461b7e8f8db9040` |
| confirmation           | `heldout-confirm-v0.8.20`, `heldout-confirm-v0.8.18-in`, `heldout-confirm-v0.8.20-probes` | unchanged                                                                                                          |

Every requirement, collection, scorer, inference rule and statistic is v13's.

## 2. The read

On 2026-11-26 the v8.11.0 candidate (config `v8.11.0-base-c6-90k-v0823-s42.yaml`, corpus
`v0.8.23-prominent-retention-overlay`) was scored against 11.3.0 on the three collections, and
`release/evaluate.run.ts` read the result against v15. Files: `/mnt/mw/models/arms/v8110/heldout-confirm-v8110.json`
and `verdict-confirm-v15-n8110.json`.

| Check                                                 | Result                | Candidate estimate                                      |
| ----------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| objective                                             | **fail**              | −0.0148, 95% interval [−0.0235, −0.0061]                |
| country minima (US, FR, GB, DE, IN, ES, IT, AU, NZ)   | pass                  | US 0.860, IN 0.811, NZ 0.939, the others 0.975 to 0.994 |
| `po_box_cedex` (both), `country_token`, `postal_unit` | pass                  |                                                         |
| `venue_unit`                                          | insufficient evidence | 26 rows                                                 |
| `geocode`                                             | insufficient evidence | the read ran without `--geocode`                        |

Outcome: `fail` on the objective. Against 11.3.0, IN fell 14.3 points (expected after the WOF India cleanup), US fell
3.5 points and NZ rose 3.6 points.

## 3. Why the read is a diagnostic

Section 6.5 of HOLDOUT_AND_EVALUATION retires a confirmation collection once a release decision has read it. v13's
three collections were read on 2026-11-19, so a later read of them can't decide a release. The v8.11.0 read still measures the
candidate: its losses are paired against the published model on rows neither trained on, and they guided the
diagnosis in #3516.

The leading explanation of the loss, untested, is the training draw: v8.11.0 gave the new source
`overture-places-in` `source_reps: 1.0`, 3,680,899 of the run's 11,520,000 draws, and every weighted source's draws
fell by a factor of 0.559 (#3516).

## 4. The next specification

v14's confirmation collections (`heldout-confirm-v0.8.22b`, `heldout-confirm-v0.8.22b-capabilities`,
`heldout-confirm-v0.8.22-probes`) have provenance audits against 11.2.0 and v8.10.0 and no recorded read. The next
release-directed specification is v14 with the published identity moved to 11.3.0, after an overlap audit of those
collections against the next candidate's corpus.
