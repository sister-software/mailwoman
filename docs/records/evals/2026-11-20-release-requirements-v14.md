---
title: Release requirements v14 draft, the 11.2.0 comparator and a pending confirmation role
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v14 draft, the 11.2.0 comparator and a pending confirmation role

Status: **draft, unregistered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v14.json`
exists beside v13, and `release/current-spec.ts` still names v13. The reader refuses v14 while its confirmation
pins read `@pending`. It is registered when a candidate passes the development role, as v12 and v13 were. No
model has read a v14 role.

## 1. What changes

| Field                  | v13                                                                                       | v14 draft                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `identities.published` | 10.8.0, `0bbb3385…e4a4`, corpus `v0.8.18-retention-overlay`                               | 11.2.0, `d51bb0ef…12b39f`, corpus `v0.8.21-retention-overlay`               |
| `identities.candidate` | v8.9.0 seed 42, `d51bb0ef…12b39f`                                                         | empty                                                                       |
| development            | `heldout-dev-v0.8.18`, `heldout-dev-v0.8.19-probes-r2`, `heldout-dev-v0.8.21`             | unchanged                                                                   |
| confirmation           | `heldout-confirm-v0.8.20`, `heldout-confirm-v0.8.18-in`, `heldout-confirm-v0.8.20-probes` | `heldout-confirm-v0.8.22@pending`, `heldout-confirm-v0.8.22-probes@pending` |
| `identities.dataset`   | the three v13 confirmation collections                                                    | the two pending pins                                                        |

Every requirement, the objective, the statistics, the provenance admission, the scorer and the inference rule are
v13's. The published sha256 is observed: `npm pack @mailwoman/neural-weights-en-us@11.2.0` on 2026-11-20 gives a
`model.onnx` of sha256 `d51bb0efa5a61e5fc7233b94f0f7c9946be988100b230bc6b17c40808112b39f`, v13's candidate, and a
card whose `training.corpus_version` is `v0.8.21-retention-overlay`.

#3156's `prominent_places` check isn't added. Its collections, `heldout-dev-prominent-v1` and
`heldout-confirm-prominent-v1`, don't exist under `/mnt/mw/corpus/heldout/`, and the issue registers the check's
minimum only after the published model's development baseline.

## 2. Reads of v13

| Date       | Role         | Arms                                 | Verdict        |
| ---------- | ------------ | ------------------------------------ | -------------- |
| 2026-11-19 | development  | 10.8.0 and v8.9.0 seed 42            | the v13 record |
| 2026-11-19 | confirmation | 10.8.0 (baseline) and v8.9.0 seed 42 | **pass**       |

The confirmation read was the one read of `heldout-confirm-v0.8.20` and `heldout-confirm-v0.8.20-probes`. Section 6.5
of HOLDOUT_AND_EVALUATION retires the three v13 confirmation collections for every later candidate.

## 3. Why the confirmation role is pending

A comparative row must be absent from the published model's corpus and the candidate's. 11.2.0 trained on
`v0.8.21-retention-overlay`, whose split (observed from its `MANIFEST.json`) is 889,265,391 train, 22,426 val and
336,925 test rows. The evaluation-group policy sends to `test` only the groups of `evaluation-groups.v0.8.21.json`,
the nine registered collections. Every other row of the corpus family trained 11.2.0 or sat in `val`, which the
overlap audit reads as training data. A draw from any v0.8.x corpus manifest therefore yields no row both
unread and unseen by 11.2.0. The procedure allows a freeze before the next corpus is built (section 4.6: a new frozen
set needs a new list, a quota pass and a re-split before a corpus trains on rows outside it, the order v12
followed), but the tools the procedure names find no admissible pool to freeze from.

The pool has to come from rows outside every corpus. The v10 record (section 4.2 and 4.3) measured where they
exist:

| Country | Largest address sources in the dev collections | Rows outside every corpus                                                           | Reader                                       |
| ------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| US      | `usgov-nad`, `tiger`, `usgov-nppes`            | NPPES `2026-11` snapshot on disk. NAD `r24` is the newest release and is read whole | `heldout/snapshot/candidates.run.ts` (NPPES) |
| FR      | `ban`                                          | BAN export of 2026-11-17 on disk                                                    | `heldout/snapshot/candidates.run.ts`         |
| AU      | `gnaf`                                         | `gnaf` rows the build didn't sample (149,969 corpus rows)                           | `heldout/snapshot/candidates.run.ts`         |
| ES, IT  | `overture`                                     | `overture` rows the build didn't sample                                             | `heldout/snapshot/candidates.run.ts`         |
| IN      | `osm-in`                                       | `osm-in` rows the build didn't sample                                               | `heldout/snapshot/candidates.run.ts`         |
| GB      | `rendered-gb-os-open`                          | recipe inputs the render didn't draw                                                | none: the recipe has no unsampled-row reader |
| DE      | `rendered-de`, `spliced-affix`                 | recipe inputs the render didn't draw                                                | none                                         |
| NZ      | `gleif-lei`, `fragment-assay`                  | none measured                                                                       | none                                         |

The operator stopped the newer-snapshot draw on 2026-11-18 (the v10 record, section 4.3), and that decision stands.
The capability probes can be rendered anew (`heldout/probes/build.run.ts`), and the `venue_unit` and
`country_token` sources (`spliced-sub-venue`, `spliced-country`) are corpus recipes whose unread rows need a new
render with a seed no build used.

## 4. The draw of `heldout-confirm-v0.8.22` from the v0.8.22 build

Decided 2026-11-20: the collection is drawn from the v0.8.22 build, and no snapshot is drawn outside a corpus. A
draw with `heldout/snapshot/candidates.run.ts` from the NPPES `2026-11` snapshot and the BAN 2026-11-17 export would
reverse the operator's 2026-11-18 decision. The pending corpus fixes already require a v0.8.22 build before the next
training run, so this draw adds no build of its own.

The build splits each rebuilt source under the holdout policy before the evaluation-group re-split. Its held-out
places are the pool. The audit against `v0.8.21-retention-overlay` keeps only the rows 11.2.0 never read. Those
are the rows the build holds and no v0.8.21 file holds, so a country's pool is as large as the rows v0.8.22 adds
for it. A country short of 75 comparison-eligible groups after the redraw of step 2 reads insufficient evidence,
and the release report names it. The collection's groups go on the list before the re-split, so the candidate
trained on v0.8.22 never sees them. The probe set is rendered with `heldout/probes/build.run.ts` and fresh seeds,
excluding every earlier probe set, `v0.8.21-retention-overlay` and the build.

### Commands, after the v0.8.22 build

`<build>` is the build's `MANIFEST.json`. `<seed>` is an integer no earlier freeze used (v12 used 1827, the v0.8.20
probes 1901 and 1824).

```sh
# 1. Freeze 1,000 rows per country and kind from the build's held-out places, excluding every frozen collection.
node --max-old-space-size=8192 packages/mailwoman/tools/eval-harness/heldout/dataset/freeze.run.ts \
  --manifest <build> --dataset-id heldout-confirm-v0.8.22 --per-country 1000 --seed <seed> \
  --duckdb-memory-gib 4 --duckdb-threads 4 \
  --exclude-dataset /mnt/mw/corpus/heldout/heldout-dev-v0.8.21.json,/mnt/mw/corpus/heldout/heldout-dev-v0.8.18.v4.json,/mnt/mw/corpus/heldout/heldout-dev-v0.8.19-probes-r2.v2.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.20.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.18.v3.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.18-in.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.20-probes.json,/mnt/mw/corpus/heldout/heldout-dev-v0.8.20-probes.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.19-probes-r2.json \
  --out /mnt/mw/corpus/heldout/heldout-confirm-v0.8.22.json

# 2. Audit against 11.2.0's corpus. A country with fewer than 75 verified_unseen address groups is redrawn at
#    4,000 rows per country with another seed, and the short draw is discarded unread, as v12's first draw was.
node --max-old-space-size=8192 packages/mailwoman/tools/eval-harness/heldout/dataset/overlap.run.ts \
  --dataset /mnt/mw/corpus/heldout/heldout-confirm-v0.8.22.json \
  --corpora /mnt/mw/corpus/versioned/v0.8.21-retention-overlay/corpus-v0.8.21-retention-overlay/MANIFEST.json \
  --training-configs packages/corpus/data/training-configs/v8.9.0-base-c6-90k-v0821-s42.yaml \
  --match-text --match-address --duckdb-memory-gib 4 --duckdb-threads 4 \
  --out /mnt/mw/corpus/heldout/heldout-confirm-v0.8.22.provenance-11.2.0.json

# 3. The probe set, with render and draw seeds no earlier probe set used, then its audit as in step 2.
node --max-old-space-size=8192 packages/mailwoman/tools/eval-harness/heldout/probes/build.run.ts \
  --corpora /mnt/mw/corpus/versioned/v0.8.21-retention-overlay/corpus-v0.8.21-retention-overlay/MANIFEST.json,<build> \
  --exclude-datasets /mnt/mw/corpus/heldout/heldout-dev-v0.8.19-probes-r2.v2.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.19-probes-r2.json,/mnt/mw/corpus/heldout/heldout-dev-v0.8.20-probes.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.20-probes.json \
  --name v0.8.22-probes --render-seed <render seed> --seed <dev seed> --confirm-seed <confirm seed> \
  --out /mnt/mw/corpus/heldout

# 4. The list the re-split reads: v0.8.22's keys and groups plus both new collections.
node packages/mailwoman/tools/eval-harness/heldout/dataset/evaluation-groups.run.ts \
  --extend packages/corpus/data/holdout/evaluation-groups.v0.8.22.json \
  --datasets /mnt/mw/corpus/heldout/heldout-confirm-v0.8.22.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.22-probes.json \
  --out packages/corpus/data/holdout/evaluation-groups.v0.8.22-confirm.json

# 5. The validation quota and the re-split under the new list, as section 4.6 orders them.
node packages/mailwoman/tools/dev-tools/corpus/validation/quota.run.ts \
  --manifest <build> --config <next training config .yaml> \
  --evaluation-groups packages/corpus/data/holdout/evaluation-groups.v0.8.22-confirm.json \
  --out <build directory>/VALIDATION_GROUPS.json
node --max-old-space-size=8192 packages/mailwoman/tools/dev-tools/corpus/resplit.run.ts \
  --manifest <build> --out /mnt/mw/corpus/versioned/v0.8.22-retention-overlay --corpus-version 0.8.22-retention-overlay \
  --evaluation-groups packages/corpus/data/holdout/evaluation-groups.v0.8.22-confirm.json \
  --validation-groups <build directory>/VALIDATION_GROUPS.json --jobs 4

# 6. The register, from the manifest and the audit. No model reads the rows.
node packages/mailwoman/tools/eval-harness/heldout/dataset/coverage/register.run.ts \
  --dataset /mnt/mw/corpus/heldout/heldout-confirm-v0.8.22.json \
  --spec packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v14.json \
  --provenance /mnt/mw/corpus/heldout/heldout-confirm-v0.8.22.provenance-11.2.0.json
```

The reader refuses v14 while it holds a placeholder, so step 6 runs after both `@pending` pins in v14 are replaced
with the frozen ids and their rows sha256.

## 5. NAD grouping (#3125) and the development role

`nadAddressKey` (`packages/corpus/lib/us/adapters/usgov/nad/address-key.ts`) keys a NAD row by state, five-digit
ZIP Code, house number, street and unit. NAD rows hold no county column, so the ZIP Code within its state stands in for
it. Over the NAD rows of the frozen collections the key is one per group: 3,134 rows of `heldout-dev-v0.8.21` give
3,123 keys for 3,123 groups, and `heldout-dev-v0.8.18` v4 and `heldout-confirm-v0.8.18` v3 give 791 and 797, with no
group holding two keys and no key two groups. `evaluation-groups.v0.8.22.json` is `evaluation-groups.v0.8.21.json`
with the 5,553 address keys of the NAD rows of those three collections and `heldout-confirm-v0.8.20`. Its 173,180
groups are v0.8.21's. Only the next re-split applies it. v0.8.21 isn't re-split.

The overlap audit of `heldout-dev-v0.8.21` with `--match-text --match-address` against corpora
`v0.8.18-retention-overlay` and `v0.8.21-retention-overlay`, 10.8.0's card and v8.9.0's config, run 2026-11-20
19:31–19:59 UTC (`/mnt/mw/audits/v14-prep/heldout-dev-v0.8.21.provenance-v890-address.json`): 34,966
`verified_unseen`, 7,418 `unseen_by_candidate`, 2,594 `known_overlap` of 44,978 rows. It finds 3,120 rows by
address key, against the text-only audit's 9,472 by text (`/mnt/mw/models/arms/v890/provenance/`). US address groups,
by the comparison each specification makes:

| Comparison                                               | Text only | With the address key |
| -------------------------------------------------------- | --------: | -------------------: |
| v13: unseen by 10.8.0 (v0.8.18) and by v8.9.0 (v0.8.21)  |        41 |                   40 |
| v14: unseen by 11.2.0 (v0.8.21), the published model now |     1,754 |                1,666 |

Under v13 the shortfall came from 10.8.0's corpus: the first evidence of 2,271 of the US known-overlap rows is an
address-key match in `v0.8.18-retention-overlay`, where another rendering of the same NAD address trained. That
corpus no longer bounds a comparison once 11.2.0 is the comparator. 11.2.0 trained on the US rows of 88 more groups
than text matching finds, and those stay `known_overlap` against it whatever the next corpus does. Every other
objective country reads the same under both audits: FR 3,923, DE 3,798, ES 3,851, IT 3,999 and AU 913 groups unseen
by 11.2.0, and GB, IN and NZ none in this collection. Their development rows are `heldout-dev-v0.8.18`'s. The
identity and group audit beside the v0.8.21 manifest (`overlap-heldout-dev-v0.8.18.json`) finds in no train or val
file. That audit compared no text and no address key.

The overlap audit of `heldout-dev-v0.8.18` v4 (`heldout-dev-v0.8.18@771811f7a5a8e4da`, rows sha256
`91f795d6…627c4448`) with `--match-text --match-address` against `v0.8.21-retention-overlay`, the corpus v8.9.0's config
names, run 2026-11-21 10:00–10:13 UTC (`/mnt/mw/audits/v14-dev-counts/heldout-dev-v0.8.18.v4.provenance-11.2.0.json`):
83,346 `verified_unseen` and 3,499 `known_overlap` of 86,845 rows, with no identity or group overlap. It finds 3,491
rows by folded text and 581 by address key. Address groups unseen by 11.2.0, counted through `readHeldoutDatasetRows`
and `heldoutRowKind` as the US counts were:

| Country | Address groups | Text only | With the address key | Target | Rows not admitted                       |
| ------- | -------------: | --------: | -------------------: | -----: | --------------------------------------- |
| GB      |            981 |       978 |                  978 |     75 | 3, folded text from `spliced-sub-venue` |
| IN      |            888 |       887 |                  887 |     75 | 1, folded text from `osm-in`            |
| NZ      |            738 |       561 |                  561 |     75 | 177, folded text from `fragment-assay`  |

The address key applies to NAD rows only, so it moves no GB, IN or NZ row. The NZ rows not admitted are
`fragment-assay` place-name fragments whose folded text, such as "falmouth", is a training row of
`part-fragment-v078.parquet`. This collection's 581 address-key rows are US, and 418 of its 1,000 US groups stay
unseen by 11.2.0.

**The 75-group target is met against 11.2.0 for US (1,666 groups in `heldout-dev-v0.8.21`), GB (978), IN (887) and
NZ (561).**

The next corpus side, measured by previewing `v0.8.21-retention-overlay` as a re-split under
`evaluation-groups.v0.8.22.json` would write it (`--preview-evaluation-groups`, 2026-11-20 19:59–20:17 UTC,
`/mnt/mw/audits/v14-prep/heldout-dev-v0.8.21.provenance-v0821-preview-v0822.json`): the preview leaves out 16,544
training rows, and no row of the collection overlaps by identity, group or address key. 267 rows still overlap by
folded text under other sources, 1 of them US (a `tiger` row). US address groups unseen by that corpus: 3,985. A
candidate trained on a v0.8.22 re-split under the list is therefore compared with 11.2.0 on 1,666 US groups, the
groups neither has read.

## 6. The candidate's decoder settings

Decided on 2026-11-21: the v14 candidate's graded arms run with these decoder settings (#3171, #3187). Each is off
by default, so the release report states the arms' pins.

| Decoder switch                | Graded arms | Reason                                                                                                                                                                               |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pairPriorWordPieces`         | on          | The pair bias wrote `I-<tag>` on the `,` after a child: 386 of 466 held-out flips in #3165. The bias on word pieces alone fixed 368 rows (+385/−0 pieces) and changed no word label. |
| `pairPriorChildPostcodeStrip` | on          | The child window took the postcode in GB (`Sutton Coldfield B72 1PU`, `Brighton BN1 1AH`), so the child bias fell on the postcode.                                                   |
| `pairIndexOwnCountry`         | off         | The locale head misreads rows: the Lebanese rows read as GB, and on 400 US probes 220 word labels changed.                                                                           |
| `fstCountryRouting`           | off         | It routes by the same locale-head read as `pairIndexOwnCountry`, so the same misreads choose another country's FST (inferred, and unmeasured on these probes).                       |
| postal-children pair index    | not shipped | At least 97 of the 184 US pairs it drops decode as two adjacent localities.                                                                                                          |
