---
title: Release requirements v10, postal_unit without loss, IE counties and the confirmation successor
role: record
audience: maintainer
owner: evaluation
---

# Release requirements v10, postal_unit without loss, IE counties and the confirmation successor

Status: **registered**. The operator's decisions of 2026-11-18 are applied in
`packages/mailwoman/tools/eval-harness/release/specs/release-requirements.v10.json`, and `release/current-spec.ts`
names it.

## 1. Route: a new version

V9 was read before this change. Lane AF scored both v9 roles for 10.8.0, the county pair and the v8.7.0 seeds 42 and 43
([the v9 record](2026-11-17-release-requirements-v9.md), section 5). Section 6.5 of
[HOLDOUT_AND_EVALUATION](../../engineering/HOLDOUT_AND_EVALUATION.mdx) records every confirmation read in the next
version's rationale, so an amendment in place would erase the version those reads were made under. V10 lists them.

## 2. postal_unit is a no-loss check

`postal_unit` registers `maxLoss: 0` and no minimum. Its loss check reads the comparative rows and the cluster
(sandwich) difference bound of `po_box_cedex`'s loss check, under the same Bonferroni correction. The family stays at
16 checks, because the loss check replaces the minimum check. Schema 4 now admits a capability without a minimum when
a `maxLoss` is registered (`release/requirements.ts`), and `release/evaluate.ts` then plans only its loss check.

The 0.85 minimum is dropped rather than kept as a separate target. Under v9 it failed every arm, the published
model's own included: 10.8.0 read 0.725 and 0.720, seed 42 read 0.825 and 0.815, and seed 43 read 0.771 and 0.765.
No training recipe draws these designators, so the rate measures the corpus, and a minimum on it fails a candidate
that repairs the published deficiency (HOLDOUT P3). Every value in the specification decides a verdict, so a target
that decides none belongs in the work plan of issue #2764. The verdict still reports each arm's rate on the check
(`publishedEstimate` plus the estimate).

At `maxLoss: 0` an arm whose difference interval reaches below zero reads insufficient evidence, as the objective
does at `minimumImprovement: 0`. 10.8.0 against itself and a resolver-only change therefore read insufficient on
`postal_unit`, never pass. Under v9 they read fail.

## 3. IE counties are region

WOF holds the 26 counties an Irish address writes as `region` places (`Westmeath` 1746652171, `Dublin` 101751737,
`Cork` 101751727), and the 31 local authorities as `county` places (`Fingal` 1746652091, `Cork` 85684963). The
gauntlet board tags `Co. Westmeath` `region`. The codex `county-designators` table now records each country's
county tag: `subregion` for US and CA, and `region` for IE. Two consumers read it:

- `heldout/dataset/relabel.ts` revision `county-designator-codex-tag` gives a `locality` or `subregion` span written
  with its country's designator the country's county tag;
- the resolver's opt-in `countyDesignatorFallback` doesn't probe a country whose county tag isn't `subregion`,
  because it retags a hit `subregion` and an IE WOF `county` is a local authority.

| Collection                      | Old                | New                | Rows changed                                       |
| ------------------------------- | ------------------ | ------------------ | -------------------------------------------------- |
| `heldout-dev-v0.8.18` (v4 file) | `adeeef40d7d81a7c` | `771811f7a5a8e4da` | 2: `subregion=co Dublin` became `region=co Dublin` |

The changed rows are `gleif-lei:gleif-lei-0ee0330b18fa` and `gleif-lei:gleif-lei-0ee0330b18fa+drop-commas`. The rows
sha256 is `91f795d685e59387e8377665920678f4374af7900de1432db4db0dae627c4448`, and the manifest sha256 is
`54a49ea1c01310545e52e9881d6ec9cf725477b3c8b64a7d68894ba4684bdcf2`. The revision changes no row of the
confirmation v3 set or either r2 probe set. A separate search for any IE span starting with `co`, `co.` or `county`
or ending with `county`, under any tag, found those 2 rows in 504 development IE rows, and the three other
collections hold no IE row.

## 4. The confirmation role

Decided by the operator on 2026-11-18: v10 keeps v9's confirmation collections,
`heldout-confirm-v0.8.18@681959088a46e5c6` with `heldout-confirm-v0.8.19-probes-r2@8d423f96f9d5a1d4`. The rationale
records every confirmation read before registration:

| Date       | Spec | Arm                                   | Collections                                | Verdict                  |
| ---------- | ---- | ------------------------------------- | ------------------------------------------ | ------------------------ |
| 2026-11-16 | v8   | v8.7.0 seed 42, postal card           | `heldout-confirm-v0.8.18@8606834b12100089` | fail                     |
| 2026-11-16 | v8   | seed 42, shaped card and fixed repair | the same                                   | insufficient evidence    |
| 2026-11-17 | v9   | 10.8.0 against itself (baseline)      | both v9 confirmation collections           | fail, from `postal_unit` |
| 2026-11-17 | v9   | `countyDesignatorFallback` on/off     | the same                                   | fail, from `postal_unit` |
| 2026-11-17 | v9   | seed 42 `n42-i8`, seed 43 `n43-i8`    | the same                                   | fail, fail               |

What section 6.5 then means for these rows. Seed 42 and seed 43 each read them and failed, so the rows are retired
for recipe selection:

- No choice of recipe, seed, checkpoint, decoder setting or corpus may be made by comparing confirmation results on
  them, including the choice between seed 42 and seed 43. Those choices read the development role.
- They stay readable for the release decision of a candidate already chosen on development, and every such read is
  recorded in the next specification's rationale. A pass on them is weaker evidence than a pass on unread rows,
  because v10's `postal_unit` change was decided after these rows' v9 verdicts were seen. The release report states
  that.
- 10.8.0's baseline scoring under v10 is its one baseline read for this version.

The plan for the successor: corpus v0.8.20's split holds out new groups, so the next confirmation collection is drawn
from its test split with `freeze.run.ts --exclude-dataset` listing every read collection, audited, and registered in
v11 before the next release-directed run. A candidate trained on v0.8.20 has never seen those groups. Seeds 42 and 43
trained on v0.8.19, so a verdict for them on the v0.8.20 draw also needs that draw's overlap audit against v0.8.19.

### 4.1 Why the v0.8.19 corpus can't supply a successor

Corpus `v0.8.19-retention-overlay` holds no group that no grading read (observed from its `MANIFEST.json`):

- its `evaluation_groups` record names `evaluation-groups.v0.8.18.json`: the 90,486 groups of
  `heldout-dev-v0.8.18` and `heldout-confirm-v0.8.18`;
- its 1,097 files' split counts sum to 886,878,119 train, 24,245 val and 221,680 test rows, and no file is a whole-file
  `test` entry, so test rows come from those frozen groups only (section 4.6);
- the development groups guided selection, and the confirmation groups are retired.

`freeze.run.ts` excluding both sets would therefore draw an empty sample. Seeds 42 and 43 trained on every other
row of this corpus. The commands below were prepared and not run:

```text
node packages/mailwoman/tools/eval-harness/heldout/dataset/freeze.run.ts \
  --manifest /mnt/mw/corpus/versioned/v0.8.19-retention-overlay/corpus-v0.8.19-retention-overlay/MANIFEST.json \
  --dataset-id heldout-confirm-v0.8.19 --out /mnt/mw/corpus/heldout/heldout-confirm-v0.8.19.json \
  --per-country 1000 --seed 1822 \
  --exclude-dataset /mnt/mw/corpus/heldout/heldout-dev-v0.8.18.v4.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.18.v3.json \
  --skip-files /data/corpus/versioned/v0.8.0/corpus-v0.8.0/part-deepseek-kryptonite-train.parquet

node packages/mailwoman/tools/eval-harness/heldout/probes/build.run.ts \
  --corpora /mnt/mw/corpus/versioned/v0.8.18-retention-overlay/corpus-v0.8.18-retention-overlay/MANIFEST.json,/mnt/mw/corpus/versioned/v0.8.19-retention-overlay/corpus-v0.8.19-retention-overlay/MANIFEST.json \
  --exclude-datasets /mnt/mw/corpus/heldout/heldout-dev-v0.8.19-probes-r2.v2.json,/mnt/mw/corpus/heldout/heldout-confirm-v0.8.19-probes-r2.json \
  --out /mnt/mw/corpus/heldout --name v0.8.19-probes-r3 --render-seed 1901 --seed 1823 --confirm-seed 1824
```

`freeze.run.ts --exclude-dataset` now takes several manifests: the development set first, recorded as
`sampling.excludes`, then every set a grading read, recorded under `sampling.excludesRead`. `probes/build.run.ts
--exclude-datasets` keeps out every group and folded text of earlier frozen probe sets. Those sets sit in no
corpus split.

### 4.2 Unsampled source rows (section 6.3)

On 2026-11-18 the coordinator chose a draw from source records no corpus build sampled. It can't produce a
confirmation role that keeps seeds 42 and 43 gradable, because US and FR have no unsampled address rows. Observed:

- The development collection's largest address sources per objective country:

  | Country | Sources (rows)                                 |
  | ------- | ---------------------------------------------- |
  | US      | `usgov-nad` 791, `tiger` 107, `usgov-nppes` 90 |
  | FR      | `ban` 996                                      |
  | GB      | `rendered-gb-os-open` 840                      |
  | DE      | `rendered-de` 584, `spliced-affix` 170         |
  | IN      | `osm-in` 461                                   |
  | ES      | `overture` 909                                 |
  | IT      | `overture` 998                                 |
  | AU      | `gnaf` 575                                     |
  | NZ      | `gleif-lei` 482, `fragment-assay` 386          |

- The `ban`, `usgov-nad` and `usgov-nppes` adapters emit every record that passes their field checks. Their only cap
  is `limit`, which `packages/corpus/data/builds/v0.8.19-rebuild/inputs.json` doesn't set, and `tiger` is emitted
  whole too. The records they skip lack a locality, a postcode or a parseable street line, so they can't be address
  rows either.
- Supply exists where a build sampled: `gnaf` (149,969 corpus rows), `overture`, `osm-in`, the `rendered-gb-os-open`
  and `rendered-de` recipe outputs, and the WOF and GeoNames gazetteer adapters. Each needs its own reader of the
  records it left out. No such reader exists, and two of these sources come from recipes rather than adapters.

A confirmation role drawn this way has no admitted US or FR rows. `country-US`, `country-FR` and the objective's
US and FR strata would read insufficient evidence for every arm, so no verdict could pass.

### 4.3 Newer snapshots (section 6.4), stopped

The coordinator then chose newer releases of the US and FR sources. Observed on 2026-11-18:

| Source        | Corpus read                                               | Newest published                                                  |
| ------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `usgov-nppes` | `2026-05` (`npidata_pfile_20050523-20260510.csv`)         | `NPPES_Data_Dissemination_November_2026_V2.zip` (`2026-11`)       |
| `usgov-nad`   | `r24`, archive 8,477,543,836 bytes                        | `r24`: the portal's archive is the same size, compiled 2026-09-30 |
| `ban`         | `corpus/staging/ban-france.csv`, downloaded by 2026-06-12 | the national export, last modified 2026-11-17                     |

The NPPES `2026-11` snapshot and the BAN export were downloaded to `/mnt/mw/snapshots/usgov-nppes/2026-11/` and
`/mnt/mw/snapshots/ban/2026-11-17/ban/`. The operator then decided not to refresh these sources, and the candidate
run was stopped and its partial output removed. `heldout/snapshot/candidates.run.ts` stays for a later section 6.4
draw.

## Reproduce

Scripts in `scratchpad/2026/11/18/lane-ai/` of the lane worktree: `ie-county-survey.ts` (the IE designator search)
and `test-split-census.ts` (the split counts). The relabel ran as
`relabel.run.ts --source heldout-dev-v0.8.18.v3.json --out heldout-dev-v0.8.18.v4.json --relabel county-designator-codex-tag`.
