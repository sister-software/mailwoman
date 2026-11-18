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

## 5. Verdicts under v10

Run 2026-11-18 01:22–03:14 UTC at commit `2d0b660ea4`, with lane AF's arms and provenance files (the v9 record,
section 5). Every report was geocoded against `/mnt/mw/db/wof/candidate.db`, which pointed to
`/mnt/mw/db/wof/candidate-global-2026-11-16.db` at the start and end of each of the four reports. Reports, verdicts
and logs are under `/mnt/mw/models/arms/v10/`, written by `scratchpad/2026/11/18/lane-ai/v10-verdicts.ts`. Bonferroni
over 16 checks.

Every verdict is `insufficient_evidence`, and every one states `the candidate artifact identity is unregistered`. No
check fails in any of the eight.

### 5.1 10.8.0 against itself, and `countyDesignatorFallback` on against off

The two arms differ only in the geocode check, so one table holds both. Estimates are point [bound], groups.

| Check                  | Development                  | Outcome      | Confirmation                       | Outcome      |
| ---------------------- | ---------------------------- | ------------ | ---------------------------------- | ------------ |
| `country-US`           | 0.929 [0.673, 0.998], 28     | pass         | 0.846 [0.407, 0.995], 13           | insufficient |
| `country-FR`           | 0.981 [0.844, 1.000], 52     | insufficient | 1.000 [0.889, 1.000], 55           | insufficient |
| `country-GB`           | 0.997 [0.985, 1.000]         | pass         | 1.000 [0.993, 1.000]               | pass         |
| `country-DE`           | 0.993 [0.979, 0.999]         | pass         | 0.995 [0.982, 0.999]               | pass         |
| `country-IN`           | 0.865 [0.815, 0.906]         | pass         | 0.894 [0.828, 0.941]               | pass         |
| `country-ES`           | 0.858 [0.822, 0.890]         | pass         | 0.877 [0.843, 0.906]               | pass         |
| `country-IT`           | 0.848 [0.811, 0.880]         | pass         | 0.840 [0.803, 0.872]               | pass         |
| `country-AU`           | 0.981 [0.958, 0.993]         | pass         | 0.977 [0.954, 0.991]               | pass         |
| `country-NZ`           | 0.960 [0.923, 0.983]         | pass         | 0.923 [0.776, 0.987], 65           | insufficient |
| `po_box_cedex` minimum | 0.846 [0.828, 0.862]         | insufficient | 0.849 [0.831, 0.865]               | insufficient |
| `po_box_cedex` loss    | 0.000 [−0.002, 0.002]        | pass         | 0.000 [−0.002, 0.002]              | pass         |
| `venue_unit`           | 0.988 [0.898, 1.000]         | pass         | 0.961 [0.847, 0.997]               | insufficient |
| `country_token`        | 1.000 [0.928, 1.000]         | pass         | 1.000 [0.933, 1.000]               | pass         |
| `postal_unit` loss     | 0.000 [−0.007, 0.007], 1,017 | insufficient | 0.000 [−0.008, 0.008], 965         | insufficient |
| `geocode` loss, self   | 0.000 [−0.003, 0.003]        | pass         | 0.000 [−0.012, 0.012]              | insufficient |
| `geocode` loss, county | +0.0016 [−0.0014, +0.0045]   | pass         | +0.0019 [−0.0101, +0.0139]         | insufficient |
| objective              | 0.000 [−0.034, 0.034]        | insufficient | no ES, IT, AU, NZ comparative rows | insufficient |

`postal_unit` reads 10.8.0's rate as 0.725 (development) and 0.720 (confirmation), the v9 values. Under v9 it failed
both arms. Under v10 it reads insufficient, as section 2 expects of two arms with one model. The default for
`countyDesignatorFallback` stays off, because no verdict passes.

### 5.2 v8.7.0 seeds 42 and 43 against 10.8.0

| Check                  | s42 development            | s43 development            | s42 confirmation                    | s43 confirmation                    |
| ---------------------- | -------------------------- | -------------------------- | ----------------------------------- | ----------------------------------- |
| `country-US`           | 0.845 [0.809, 0.877] pass  | 0.840 [0.803, 0.873] pass  | 0.824 [0.786, 0.858] pass           | 0.822 [0.784, 0.856] pass           |
| `country-FR`           | 0.996 pass                 | 0.996 pass                 | 0.988 pass                          | 0.986 pass                          |
| `country-GB`           | 0.991 pass                 | 0.991 pass                 | 0.995 pass                          | 0.995 pass                          |
| `country-DE`           | 0.987 pass                 | 0.987 pass                 | 0.989 pass                          | 0.989 pass                          |
| `country-IN`           | 0.933 pass                 | 0.933 pass                 | 0.961 pass                          | 0.954 pass                          |
| `country-ES`           | 0.974 pass                 | 0.979 pass                 | 0.980 pass                          | 0.980 pass                          |
| `country-IT`           | 0.995 pass                 | 0.993 pass                 | 0.995 pass                          | 0.993 pass                          |
| `country-AU`           | 0.989 pass                 | 0.927 pass                 | 0.985 pass                          | 0.931 pass                          |
| `country-NZ`           | 0.958 pass                 | 0.951 pass                 | 0.945 [0.819, 0.993] pass           | 0.959 [0.840, 0.997] pass           |
| `po_box_cedex` minimum | 0.881 [0.865, 0.895] pass  | 0.894 [0.879, 0.908] pass  | 0.886 [0.870, 0.900] pass           | 0.901 [0.886, 0.914] pass           |
| `po_box_cedex` loss    | +0.035 [0.023, 0.048] pass | +0.049 [0.037, 0.061] pass | +0.037 [0.025, 0.049] pass          | +0.052 [0.041, 0.064] pass          |
| `venue_unit`           | 0.988 pass                 | 1.000 pass                 | 0.974 pass                          | 0.987 pass                          |
| `country_token`        | 1.000 pass                 | 1.000 pass                 | 1.000 pass                          | 1.000 pass                          |
| `postal_unit` loss     | +0.100 [0.072, 0.129] pass | +0.046 [0.023, 0.069] pass | +0.094 [0.066, 0.123] pass          | +0.045 [0.020, 0.069] pass          |
| `geocode` loss         | +0.037 [0.016, 0.058] pass | +0.039 [0.017, 0.060] pass | +0.037 [−0.035, 0.108] insufficient | +0.036 [−0.035, 0.107] insufficient |
| objective              | +0.045 [0.024, 0.066] pass | +0.047 [0.031, 0.062] pass | +0.043 [−0.029, 0.114] insufficient | +0.040 [−0.032, 0.111] insufficient |

On development both seeds pass every check. The only reason left is the unregistered candidate identity. On
confirmation the geocode and objective bounds are wide: the v870 audit's comparative rows hold 13 US and 73 NZ
groups (the v9 record, section 6). Section 4 forbids choosing between the two seeds by
these confirmation results.

## Reproduce

Scripts in `scratchpad/2026/11/18/lane-ai/` of the lane worktree: `ie-county-survey.ts` (the IE designator search)
and `test-split-census.ts` (the split counts). The relabel ran as
`relabel.run.ts --source heldout-dev-v0.8.18.v3.json --out heldout-dev-v0.8.18.v4.json --relabel county-designator-codex-tag`.
