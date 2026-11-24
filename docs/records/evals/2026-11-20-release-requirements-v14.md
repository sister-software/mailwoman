---
title: Release requirements v14 draft, the 11.2.0 comparator and a pending confirmation role
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v14 draft, the 11.2.0 comparator and a pending confirmation role

Status: **draft, unregistered**. `packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v14.json`
exists beside v13, and `release/current-spec.ts` still names v13. Its confirmation pins name the three collections
section 9 records, drawn on 2026-11-22 from rows no corpus holds. They replace `heldout-confirm-v0.8.22` of section 7.
That collection held too few eligible groups to decide a release, and no model read it. Section 8 records its
retirement, the forward reserve and the second re-split of v0.8.22. The specification is registered when
a candidate passes the development role, as v12 and v13 were. No model has read a v14 role.

## 1. What changes

| Field                  | v13                                                                                       | v14 draft                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `identities.published` | 10.8.0, `0bbb3385…e4a4`, corpus `v0.8.18-retention-overlay`                               | 11.2.0, `d51bb0ef…12b39f`, corpus `v0.8.21-retention-overlay`                                                     |
| `identities.candidate` | v8.9.0 seed 42, `d51bb0ef…12b39f`                                                         | empty                                                                                                             |
| development            | `heldout-dev-v0.8.18`, `heldout-dev-v0.8.19-probes-r2`, `heldout-dev-v0.8.21`             | unchanged                                                                                                         |
| confirmation           | `heldout-confirm-v0.8.20`, `heldout-confirm-v0.8.18-in`, `heldout-confirm-v0.8.20-probes` | `heldout-confirm-v0.8.22b`, `heldout-confirm-v0.8.22b-capabilities`, `heldout-confirm-v0.8.22-probes` (section 9) |
| `identities.dataset`   | the three v13 confirmation collections                                                    | the same three pins                                                                                               |

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

| Decoder switch                | Graded arms | Reason                                                                                                                                                                                              |
| ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairPriorWordPieces`         | on          | The pair bias wrote `I-<tag>` on the `,` after a child: 386 of 466 held-out flips in #3165. The bias applied only to word pieces and fixed 368 rows (+385/−0 pieces) without changing a word label. |
| `pairPriorChildPostcodeStrip` | on          | The child window took the postcode in GB (`Sutton Coldfield B72 1PU`, `Brighton BN1 1AH`), so the child bias fell on the postcode.                                                                  |
| `pairIndexOwnCountry`         | off         | The locale head misreads rows: the Lebanese rows read as GB, and on 400 US probes 220 word labels changed.                                                                                          |
| `fstCountryRouting`           | off         | It routes by the same locale-head read as `pairIndexOwnCountry`, so the same misreads choose another country's FST (inferred, and unmeasured on these probes).                                      |
| postal-children pair index    | not shipped | At least 97 of the 184 US pairs it drops decode as two adjacent localities.                                                                                                                         |

## 7. The draw, 2026-11-22

Corpus v0.8.22 is an overlay on `v0.8.21-retention-overlay` (`packages/corpus/data/builds/v0.8.22-overlay/OVERLAY_PLAN.json`):
`wof-admin` rebuilt, `rendered-de` re-rendered, and `rendered-former-divisions` and `rendered-prominent-places` added.
The build's manifest, `v0.8.22-overlay`, is the `<build>` of section 4. Its test rows outside every frozen group are
those four sources' held-out places. Every other file reuses its v0.8.21 contents and split. The test rows in those files
are frozen groups only.

The freeze excluded the nine collections section 4 lists and skipped two unchanged v0.8.21 files,
`invented-po-box-cedex-v0.8.20.parquet` and `invented-postal-unit-guideline-v0.8.20.parquet`. Their test rows are
`v0.8.20-recipe-probe-text-collisions`' groups, a set the group list sends to test that no dataset manifest records,
so `--exclude-dataset` can't name it. Without the skip, the draw took 50 of their rows (US 20, FR 13, CA 9, NZ 5, AU 3),
whose text repeats a read probe row's. The first draw of 1,000 per country (seed 2211) left every objective country
under 75 groups, and was discarded with only its counts read. The redraw at 4,000 (seed 2212) is the collection:

| Collection                                        |  Rows | Rows sha256 | Audit against `v0.8.21-retention-overlay`, folded text and address key |
| ------------------------------------------------- | ----: | ----------- | ---------------------------------------------------------------------- |
| `heldout-confirm-v0.8.22@5383e65f6aa768bb`        | 4,681 | `ea90895f…` | 1,224 `verified_unseen`, 3,457 `known_overlap`                         |
| `heldout-confirm-v0.8.22-probes@cbbe8ed53c10e55d` | 5,000 | `fc438185…` | 5,000 `verified_unseen`, no overlap of any kind                        |

The redraw holds the same 1,224 admitted rows as the 1,000-row draw, so the pool is exhausted. Comparison-eligible
address groups (`heldoutRowKind`) against the 75 target:

| Country | Address rows | Eligible groups | Sources                                                   |
| ------- | -----------: | --------------: | --------------------------------------------------------- |
| US      |            0 |               0 | none                                                      |
| FR      |            0 |               0 | none                                                      |
| GB      |            0 |               0 | none                                                      |
| ES      |            0 |               0 | none                                                      |
| AU      |            0 |               0 | none                                                      |
| DE      |        3,261 |               1 | `rendered-de`: 3,071 rows match a v0.8.21 row by identity |
| IN      |            4 |               2 | `rendered-prominent-places`                               |
| IT      |           10 |              10 | `rendered-former-divisions`                               |
| NZ      |           19 |               8 | `rendered-prominent-places`                               |

Every objective country reads insufficient evidence. The re-render of `rendered-de` keeps v0.8.21's seed and its rows'
source ids, so its held-out rows are rows 11.2.0 read. `heldoutRowKind` counts `rendered-prominent-places` and
`rendered-former-divisions` rows as addresses, though each writes one to four admin components. The collection's
gazetteer rows are `wof-admin`'s: 1,080 rows in 440 groups, 369 of them eligible, NZ 142.

Against `v0.8.22-retention-overlay`, the re-split under `evaluation-groups.v0.8.22-confirm.json`, the collection overlaps
no train or val row by identity, group or address key. 132 rows match by folded text, 8 of them rows the audit
against 11.2.0 admitted. All 5,000 probe rows stay unmatched by every kind.

The freeze costs the prominent-place receipt (#3156) its presence rule. A `rendered-prominent-places` row takes its
place's WOF record as `base_source_id`, so it shares the group of that record's `wof-admin` rows. The collection froze
the groups of 123 of the recipe's 16,425 places, and the validation quota chose 16 more, so the re-split sends their
rows out of train. On the v8.10.0 config the receipt covers 20,584 of 20,947 required forms and fails 11 of 813
demand cells. Coherence passes.

## 8. The retirement of `heldout-confirm-v0.8.22`, the forward reserve and the second re-split

`heldout-confirm-v0.8.22@5383e65f6aa768bb` is retired unread on 2026-11-22 (#3333). Against 11.2.0's corpus it holds
1,224 `verified_unseen` rows of 4,681, and its comparison-eligible address groups are US, FR, GB, ES and AU 0, DE 1,
IN 2, IT 10 and NZ 8 against the 75-group target (section 7), so no objective country can read anything but
insufficient evidence. Its freeze and the quota drawn beside it took 139 of the 16,425 prominent places out of
training. Its groups return to training: `evaluation-groups.v0.8.22-reserve.json` extends `evaluation-groups.v0.8.22.json`
with `heldout-confirm-v0.8.22-probes` and the reserve below, and leaves `heldout-confirm-v0.8.22` out. The probe set
keeps its pin.

**The forward reserve.** `heldout-reserve-v0.8.22@681f928c68575cc3` (rows sha256 `02139b6d…`) draws 400 groups per
country and row kind (seed 2216) from the train pool of the first v0.8.22 re-split (manifest sha256 `ddc5b111…`),
skipping the groups of the 7,764 places the v8.10.0 config's prominent-place receipt requires and every frozen
collection's groups: 7,200 groups and 20,537 rows, address and gazetteer, in the nine objective countries. The countries
come from the specification's objective and country requirements (`freeze.run.ts --reserve-spec`). Under the pass
proof, at 0.95 against 0.85 and with the reserve's rows assumed `verified_unseen`, every country check reads `pass`,
FR's lower bound 0.935 against 0.9. The capability checks read insufficient evidence on the reserve, because their rows
come from the probe and capability collections rather than a per-country draw.

The first draw took 400 groups in every one of 259 countries (160,652 groups), and its re-split (manifest sha256
`41f74e22…`) emptied the train rows of 17 sources and shrank 78 by a tenth or more: in a small country 400 groups is
most of the pool. The sampler refused the corpus (`reps-targeted sources have no readable train rows`) for `gbpa-bs` and 16
`osm-<cc>` sources. That draw and that manifest were read by no model and are kept under
`/mnt/mw/corpus/heldout/superseded/reserve-all-countries-2026-11-22/`. Before the second re-split, a dry run over the
first split's train rows found 20,564 rows of 38 sources leaving training, every one in the nine countries, at most
1.28% of a source (`nz-charities-register`, weighted 0).

**The second re-split.** The validation quota (`--config v8.10.0-base-c6-90k-v0822-s42.yaml`, 15,330 groups, 226
required groups skipped, `VALIDATION_GROUPS.reserve.json` sha256 `5100f0b1…`) and the re-split under the reserve list
(sha256 `654817a9…`, `--jobs 8`, 10,363 s) wrote `v0.8.22-retention-overlay` MANIFEST.json sha256
`7d8717025f6b64296064fc09fe5f831eb345e6212d00d38eb514d4e75c04386b`: 1,104 files, train 889,226,069, val 23,392, test
381,093. Against the first split, the 17 emptied sources hold their earlier train rows exactly, every source holds at
least its earlier count less the dry run's loss, and seven gain the retired collection's rows (`rendered-prominent-places` 32,040
to 32,416).

**The receipts on that manifest.** The epoch mixture meets every receipt (`former-divisions-exposure` 1,406 against a
minimum of 1,239, `prominent-places-exposure` 11,706 against 10,505), and validation coverage and label support pass.
The prominent-place receipt fails four items:

| Item                       | First split (`ddc5b111…`) | Second split (`7d871702…`) | Cause                                                                                                                                         |
| -------------------------- | ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| NZ Rotorua, `country` form | covered                   | 0 train rows               | its only such rows are group `wof-admin-1729238557-default-with-country-form`, another WOF record's. The reserve drew that group              |
| CA locality `region`       | 0.4203 against 0.4205     | 0.4177 against 0.4203      | the recipe's train rows rose 1.2%, so each draws 1.14% less. The cell already failed on the first split                                       |
| CA locality `region_abbr`  | 0.4204 against 0.4205     | 0.4184 against 0.4203      | the same                                                                                                                                      |
| PW locality `bare`         | 0.3316 against 0.3248     | 0.3295 against 0.3338      | the same dilution, and the target rises when the receipt leaves Babeldaob South – Airai State (decile 2, held out by design) out of the count |

The required-group skip keys a place's groups by its WOF record, and the receipt counts any train row whose surface
writes the place, so a namesake record's group covers a required form without being skipped. The census sized the
recipe's rows to close each cell at its target on the base build, so a later split that changes the recipe's train rows
moves those cells. Timmins (decile 1) reads held out by design while one train row in a group of another record writes
it, so the receipt drops that row's 0.347 draws. The operator approved the fixes and a third re-split on 2026-11-23
(#3333).

**The third re-split.** Four changes went in before it:

1. A form is held out by design only when rows of listed groups write that form's own surface in its shape and no
   drawable train row does. Before this change a place counted as held out when its own WOF groups were all listed. On
   the candidate, 31 selected places counted as held out under the place-level reading, 21 of them only because a row
   of another of their names was frozen, such as Changsha's `-name-kan-x-preferred-with-region-country` row. Under the per-form rule those 21 keep
   their primary-name forms required, and 4 forms stay held out, each the frozen row's own surface: the `country` forms
   of Relizane, Roeselare, Berovo and Moquegua.
2. The census's `tuples` step sizes through the receipt's reader (`readSizingCells`), so the two compute the same
   held-out forms and the same targets. On the candidate, the earlier sizing used a different held-out set from the
   receipt's in 300 of 739 cells, and that difference is what failed PW.
3. The reserve and the validation quota skip the groups of every decile-1 place the recipe may write. The quota had
   sent 14 recipe rows of 7 CA decile-1 places to validation after the recipe was sized, and those rows failed both CA
   cells.
4. The reserve also skips every group whose short admin train rows write a required form. That keeps Rotorua's
   namesake group in training.

Two other designs were measured on the candidate and not taken:

- The fixed-point design releases a place whenever the recipe's text matches it. It covers every required form and leaves
  the 21 places held out.
- The place-level hold-out with the recipe rows dropped whose text matches a held-out place fails 2 of 20,892
  forms. Both are the namesake Huancayo in Lima (WOF 421177467), bare and `country`.

The re-sized recipe holds 32,378 rows for 16,421 places, every one in train after the re-split. The reserve was redrawn
as `heldout-reserve-v0.8.22@b2a259ef6bcba5b4` (7,200 groups, 20,500 rows, seed 2216, from the first split's train
pool), and the group list `evaluation-groups.v0.8.23.json` (sha256 `cfaffa67…`, 201,538 groups) holds it beside the
section 9 collections. The quota chose 15,300 validation groups (sha256 `6e9ddd98…`) on both the base and the
recipe-joined build. The re-split (`--jobs 8`, 8,679 s) wrote MANIFEST.json sha256
`c01019fe088458f8e4950fc8245583083f7e230c3446b1bc4952947186f334fd`: 1,104 files, train 889,226,116, val 23,330, test
381,056.

**The receipts on that manifest** all exit 0:

| Receipt                  | Result                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Prominent-place coverage | presence 20,910 of 20,910 forms. 808 of 811 demand cells meet their targets, none fails, 3 unwritable (FJ, GD, ID). Coherence 0 rows |
| Epoch mixture            | all 71 receipts. `former-divisions-exposure` 1,441 against 1,240, `prominent-places-exposure` 11,825 against 10,505                  |
| Validation coverage      | all 21 floors                                                                                                                        |
| Label support            | passes                                                                                                                               |

**The audits.** Against v0.8.21-retention-overlay and this manifest under both training configs, the section 9
collections read `verified_unseen` on every row (8,358, 7,800 and 5,000). The development collections read
`verified_unseen` 83,278, 5,000 and 42,384, with 3,229 `known_overlap` and 2,932 `unseen_by_candidate` rows among
them. The pass proof under spec 14 is proven for both roles: the arm at 0.95 against the published 0.85 passes every
check, and the arm at 0.85 doesn't pass. With this manifest as the only comparison input, the reserve's rows overlap training by folded
text in 1,168 of 20,500 rows, by identity, group and address in none. Those rows read `known_overlap` for the v15
confirmation draw.

## 9. The draw of `heldout-confirm-v0.8.22b` from rows outside every corpus

Decided by the operator on 2026-11-22: the confirmation role is drawn from source rows no corpus holds, reversing the
2026-11-18 stop on a newer-snapshot draw (section 3). No corpus is rebuilt for it. Three collections make up the role:

| Collection                                               |  Rows | Rows sha256 | What it holds                                    |
| -------------------------------------------------------- | ----: | ----------- | ------------------------------------------------ |
| `heldout-confirm-v0.8.22b@35005b713649d486`              | 8,358 | `7c0a9dd9…` | the address rows of the nine objective countries |
| `heldout-confirm-v0.8.22b-capabilities@6d55f1bee295a4ed` | 7,800 | `ae58924c…` | `spliced-sub-venue` and `spliced-country` rows   |
| `heldout-confirm-v0.8.22-probes@cbbe8ed53c10e55d`        | 5,000 | `fc438185…` | the probe set of section 7, unchanged            |

### 9.1 Sources

| Country | Source                                                                        | Rows 11.2.0 didn't read                                                                                                            |
| ------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| US      | NPPES weekly files `110226_110826` and `110926_111526`                        | NPIs absent from the `2026-11` monthly file, the file v0.8.20-rebuild read (`builds/v0.8.20-rebuild/inputs.json`)                  |
| FR      | BAN export of 2026-11-17, metropolitan France and Corsica                     | ids absent from `corpus/staging/ban-france.csv`, the file v0.8.19-rebuild read                                                     |
| ES      | `es-bizkaia`, `es-gipuzkoa`, `es-navarra`, reserved for evaluation by #3353   | the whole publication: no training manifest reads them, and `evaluationSourceProblems` returns no problem for any of the three     |
| AU      | a 60,000-tuple sample of G-NAF May 2026 (`mailwoman gnaf assemble --n 60000`) | tuples outside the corpus's 149,969 `gnaf` rows                                                                                    |
| IN      | Geofabrik India of 2026-11-22                                                 | objects with a house number that are new (2,538) or changed by id and version (1,187) against the 2026-10-02 extract `osm-in` read |
| GB      | recipe `locale --country GB`, render seed 2242, 40,000 rows                   | a render no corpus holds, from the OS Open tuples behind `rendered-gb-os-open`                                                     |
| DE      | recipe `german`, render seed 2241, 40,000 rows                                | a render no corpus holds. v0.8.22's `rendered-de` used seed 42                                                                     |
| IT      | recipe `locale --country IT`, render seed 2244, 40,000 rows                   | a render of OpenAddresses `it/countrywide`, which no corpus renders                                                                |
| NZ      | recipe `locale --country NZ`, render seed 2243, 40,000 rows                   | a render of OpenAddresses `nz/countrywide` (LINZ). v0.8.22 holds no `rendered-nz` file                                             |

The capability collection renders `sub-venue` (seed 2245, 40,000 rows, the `house-venue-tuples-v6` skeletons the corpus
file used) and `country-balanced` (seed 2246, 150,000 rows, so the head-of-file pool reaches past the 50,000-row corpus
file's records). `po_box_cedex` and `postal_unit` read the probe set.

### 9.2 Filters

Each source's own adapter labels its rows as a build does, without augmentation (`heldout/snapshot/candidates.ts`
where the adapter is a corpus source). Every row is then compared with every row of every split of the 1,110 data files
that v0.8.21-retention-overlay and v0.8.22-retention-overlay list, by identity, group, folded text and address key, and
a pool keeps one row per address key and folded text. A US row's key is `nadAddressKey`. Any other row keys by its
country, postcode or locality, house number, street and unit, folded as `nadAddressKey` folds its parts, and a row with
no house number or no street gives no key and is dropped, because it can't be compared by address. The scripts are in
`/mnt/mw/audits/v14-confirm-b/scripts/` (`filter.ts`, `keys.ts`).

| Country |      In | Identity or group |   Text | Address key | No key | Repeat | Older file |    Pool | Drawn |
| ------- | ------: | ----------------: | -----: | ----------: | -----: | -----: | ---------: | ------: | ----: |
| US      |  20,085 |                 0 |    237 |      14,651 |    162 |    248 |          8 |   4,779 | 1,000 |
| FR      | 294,683 |                 0 | 46,168 |       1,350 |      0 |  1,112 |          – |  22,090 | 1,000 |
| ES      | 120,000 |                 0 |     14 |         103 |  1,345 |    193 |          – | 118,345 | 1,000 |
| AU      |  60,000 |               205 |      7 |         558 |      0 |     16 |          – |  59,214 | 1,000 |
| IN      |   2,463 |               393 |      7 |          96 |  1,496 |    113 |          – |     358 |   358 |
| GB      |  40,000 |            10,659 |      8 |       3,587 |  7,082 |    104 |          – |  18,560 | 1,000 |
| DE      |  40,000 |             7,435 |     94 |       1,848 |  3,542 |    360 |          – |  26,721 | 1,000 |
| IT      |  40,000 |                 0 |     29 |         216 |  7,778 |     97 |          – |  31,880 | 1,000 |
| NZ      |  40,000 |                 0 |      7 |         248 |  7,321 |      6 |          – |  32,418 | 1,000 |

US's address-key drops are earlier NPPES rows at the same practice address under another NPI (8,746), NAD (3,666, and
4,387 matched a NAD row at all), USGS structures (1,356) and 883 rows of eight other sources. "Older file" is the address
key of the `2026-11` monthly file's records sharing a ZIP Code and number with a candidate. DE's identity and group
drops are seed-2241 rows of a record the seed-42 render also drew, and 1,284 of its address-key drops are seed-42 rows.
BAN's new ids concentrate in re-addressed communes, so the pool keeps six rows a commune, lowest hash first, before the
corpus comparison and two after: the cap drops 223,963 of FR's rows, and the address-key count is of the 48,384 the
first cap kept. ES draws 40,000 rows of each source's 139,512, 68,744 and 180,941 before the comparison. The 339,671 NPIs
the `2026-11` monthly file adds against `2026-05` are not a pool: 334,376 of the 338,312 labeled are corpus rows by
identity and the other 3,936 by text, because v0.8.20 read that file.

### 9.3 The freeze and the audits

`freeze.run.ts --training-config v8.10.0-base-c6-90k-v0822-s42.yaml --per-country 1000` (address, seed 2251) and
`--per-country 600` (capabilities, seed 2252), every frozen collection on the data root excluded. The skip of required
training groups (7,764 prominent places) found none of its groups in either pool. A first freeze of the address
collection without US and IN (`@1dd562cb1290167a`) was read by no model and moved to `superseded/`.

`overlap.run.ts --match-text --match-address --duckdb-memory-gib 4 --duckdb-threads 4` against corpora
v0.8.21-retention-overlay and v0.8.22-retention-overlay (manifest sha256 `7d871702…386b`, the second re-split: its
1,104 data files and their sha256s are the ones the filter compared), with training configs
`v8.9.0-base-c6-90k-v0821-s42.yaml` (11.2.0) and `v8.10.0-base-c6-90k-v0822-s42.yaml` (the candidate), on 2026-11-22
22:20–23:51 UTC. The provenance files sit beside each manifest as `<collection>.provenance-11.2.0-v8.10.0.json`.

| Collection                              |  Rows | `verified_unseen` | `unseen_by_candidate` | `known_overlap` |
| --------------------------------------- | ----: | ----------------: | --------------------: | --------------: |
| `heldout-confirm-v0.8.22b`              | 8,358 |             8,358 |                     0 |               0 |
| `heldout-confirm-v0.8.22b-capabilities` | 7,800 |             7,800 |                     0 |               0 |
| `heldout-confirm-v0.8.22-probes`        | 5,000 |             5,000 |                     0 |               0 |

Eligible groups per objective country, against the 75-group target and the 300-group aim: US, FR, GB, DE, ES, IT, AU
and NZ 1,000 each, IN 358. The capability collection holds `venue_unit` 1,756 rows and `country_token` 6,044, and the
probe set `po_box_cedex` 4,000 and `postal_unit` 1,000 (upper bound: the proof reads `postal_unit` without its tag
selector). `evaluation-groups.v0.8.23.json` is `evaluation-groups.v0.8.22-reserve.json` with both new collections'
groups. The reserve list is the one the second v0.8.22 re-split read (sha256 `654817a9…8854`, recorded in the v0.8.22
manifest's `evaluation_groups`), so the next re-split keeps the new groups in test with every earlier one.

### 9.4 The pass proof

`release/pass/proof.run.ts --role confirmation` over the three collections and their audits against both corpora,
under this specification with the pins above, read 21,158 rows in 21,158 groups, all `verified_unseen`. The arm at
0.95 against the published 0.85 reads `pass` on every check, the objective at a difference of 0.098 (interval 0.087 to
0.108). The arm at 0.85 against 0.85 reads `fail`, so the evaluator separates the two (exit 0, proven). No rows file was
read and no model was scored. Before US and IN joined, the same proof against 11.2.0's audit read insufficient evidence
on the first arm, because the objective requires every one of the nine countries.

## 10. Model 11.3.0 shipped under a recorded override

On 2026-11-23 the operator decided to publish v8.10.0 seed 42 as model 11.3.0 without a `pass` verdict. No registered
specification identifies the artifact: v13 is current and names v8.9.0 seed 42 as its candidate, and this draft
records a null candidate sha256. The reason is the rights audit. Every model before 11.3.0 trained on
`nz-charities-register`, and `mwops release rights-audit` refused each release while one shipped. The v8.10.0 recipe
draws that source at weight 0, and the audit exits 0 for the new card.

The development read under this draft, against 11.2.0 on `heldout-dev-v0.8.22`, is `insufficient_evidence`: 13 of 16
checks pass, the objective reads −0.0017 [−0.0045, +0.0012], and the `postal_unit` loss reads 0.0146 [−0.0003, +0.0296]
(`/mnt/mw/models/arms/v8100/reads/verdict-dev-v14.json`). The confirmation read didn't run. The promotion check
`v9.0.0-base` passed 18 of 18 floors, with `fr.postcode` at its floor of 98.8.

The losses reported in the 11.3.0 model card are the ones the development rows show. A region written after the town
without a comma reads correctly on 138 of 297 IT post-office-box rows (11.2.0: 233), 459 of 518 AU `gleif-lei` rows
(494) and 9 of 150 UY rows (25), and `POB <n>` splits into a box word and a street on 24 rows. Five v8.x arms read
122, 254, 132, 233 and 138 of the IT rows, so the IT drop is within the spread between seeds. Published artifact:
`@mailwoman/neural-weights-en-us@11.3.0`, `model.onnx` md5 `bc7cafce5540f4f2c26908e74604908c` (#3431).
