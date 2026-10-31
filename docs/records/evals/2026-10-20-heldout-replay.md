# Held-out replay on v0.7.10-gb-county: development dataset frozen, three models scored

Date: 2026-10-20. Issue #2763. Policy: `scratchpad/2026/10/20/D_RULE_REDESIGN-confirmed.md`. Tools:
`packages/mailwoman/tools/eval-harness/heldout/` and `release/` on branch `heldout-replay`, branched from `origin/main`
34b72e60e. Each claim is marked observed, inferred, decided, or unknown.

## Outcome

Observed: the development dataset froze, and on a second pass all three arms were scored from the main checkout at
origin/main 3e632daac. Every spec v6 verdict reads insufficient evidence, because no provenance file exists and every
row is `unknown`, a class v6 admits to no check. The replay results are under "Replay from the main checkout" below.

First attempt (superseded): observed, the worktree resolves every `@mailwoman/*` package through the main checkout,
which was at d136b0052. That checkout's `@mailwoman/neural` has no `NeuralAddressClassifier.unfedChannels`, which
26ff00be4 added. `scoreHeldoutWeights` reads it (`heldout/per/country.ts`), and the first arm failed with
`TypeError: undefined is not iterable` at `const [unfed, ...more] = classifier.unfedChannels`. Decided: module
resolution was not altered to work around this. The scoring and evaluation steps need a checkout whose installed
`@mailwoman/neural` is at 26ff00be4 or later.

## Dataset identity

| Field                  | Value                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Manifest               | `/mnt/mw/corpus/heldout/heldout-dev-v0.7.10-gb-county.json`                                   |
| Dataset id and version | `heldout-dev-v0.7.10-gb-county`, version `4eba39056032f5a1`                                   |
| Rows file sha256       | `b5edbd1f19150f394bbcc3bb1eeacb5707fd51fe08dfdd9e89d2f2373f3d19bc` (26,610 rows, 103 sources) |
| Drawn from             | `corpus-v0.7.10-gb-county/MANIFEST.json`, sha256 `c499a9af…89fe1f`, 104 test files            |
| Sample method          | `per-record-country-kind-hash-order`, 1,000 per country and kind, seed 2763, DuckDB v1.5.6    |

Observed: two freezes with the same arguments wrote the same rows sha256. The manifest's own sha256 changes on every
freeze because it records `createdAt`. Freeze command, run with `MAILWOMAN_DATA_ROOT=/mnt/mw` and a 4 GiB Node heap:

```
node packages/mailwoman/tools/eval-harness/heldout/dataset/freeze.run.ts \
  --manifest /mnt/mw/corpus/versioned/v0.7.10-gb-county/corpus-v0.7.10-gb-county/MANIFEST.json \
  --dataset-id heldout-dev-v0.7.10-gb-county --per-country 1000 --seed 2763 --path-root /mnt/mw \
  --out /mnt/mw/corpus/heldout/heldout-dev-v0.7.10-gb-county.json --duckdb-memory-gib 3 --duckdb-threads 2
```

The nine required countries, address rows (observed):

| Country | Available records | Sampled rows | Sampled groups | Best possible lower bound (inferred) | Minimum |
| ------- | ----------------: | -----------: | -------------: | -----------------------------------: | ------: |
| US      |         1,787,947 |        1,000 |            999 |                                0.994 |    0.60 |
| FR      |           760,451 |        1,000 |            999 |                                0.994 |    0.90 |
| GB      |             5,978 |        1,000 |          1,000 |                                0.994 |    0.80 |
| DE      |            11,604 |        1,000 |          1,000 |                                0.994 |    0.85 |
| IN      |             3,071 |        1,000 |          1,000 |                                0.994 |    0.50 |
| ES      |               180 |          180 |            180 |                                0.965 |    0.80 |
| IT      |                 3 |            3 |              3 |                                0.119 |    0.80 |
| AU      |                32 |           32 |             32 |                                0.819 |    0.80 |
| NZ      |                28 |           28 |             28 |                                0.796 |    0.80 |

The best possible lower bound is the Clopper–Pearson lower bound when every group parses exactly, at spec v6's
per-tail level 0.05 / 15 / 2 (`adjustedPercentile`, Bonferroni over 15 checks), which reduces to `tail^(1/n)`.
Inferred: on this dataset IT and NZ cannot meet their minima for any model, and AU meets its minimum only if all 32
rows parse exactly. A verdict on this dataset would therefore read insufficient evidence for those countries
regardless of the model. The v0.7.10-gb-county test split is too thin there, and a confirmation dataset drawn from
it would be too.

Capability sources in the sample (observed): `spliced-sub-venue` 283, `invented-po-box-cedex` 97, `spliced-country` 96.
`invented-postal-guideline` and `invented-postal-unit-guideline` have no rows, so `postal_unit` would read zero rows
and `po_box_cedex` would read only `invented-po-box-cedex`. Inferred: those sources postdate this corpus. The sampler
draws per country, so capability rows enter only in proportion to their share of a country's records.

## Models staged

Each cache was staged with `stage-candidate-cache.run.ts` for all nine Latin locales and then materialized as regular
files under `/mnt/mw/tmp/heldout-replay/cache/<arm>`. The staging tool links files, so a copy step replaced every
symlink. The en-us calibration files were copied from the tracked `packages/neural-weights-en-us` copies, because
the data root lacks them. Observed model hashes:

| Arm   | Shipped as    | Model                                                 | md5                                |
| ----- | ------------- | ----------------------------------------------------- | ---------------------------------- |
| v7100 | 10.7.0        | `model-v7100-s42-step-060000-int8.onnx`               | `5356ecba83e3774a5d9717277c051ac2` |
| v720  | 10.1.0–10.6.0 | `model-v720-address-systems-step-060000-int8.onnx`    | `0f7de7042a1a888d6cbc201c768e9f00` |
| v440  | 9.1.0–10.0.0  | `model-v440-suffix-boundary-v2-step-060000-int8.onnx` | `98a49b5ca2948cdbe1dd981d60ef637d` |

The v7100 sha256 equals spec v6's published identity, `e90aeab4…d9aca9`. Each older graph was given the en-us card it
shipped with, taken from git at 321d2bf76~~1 and fa328896e~~1. Every overlay file (FST, pair indexes, postcode tables,
lexicons) comes from the current data root, which is the 10.7.0 set. A score for an older arm would therefore
measure that graph with 10.7.0 overlays rather than the package as it shipped (inferred confound). The 10.4.0 package
carries the v720 graph, so it adds no third graph.

## Replay from the main checkout

Run from `/home/lab/Projects/mailwoman` at origin/main 3e632daac, compiled, with `MAILWOMAN_DATA_ROOT=/mnt/mw` and a
4 GiB Node heap. Outputs are under `/mnt/mw/tmp/heldout-replay/run/` (`report.json`, `verdict-*.json`, `score.log`).
The scorer scored all three arms in one process, so it held one model at a time:

```
node packages/mailwoman/tools/eval-harness/heldout/per/country.run.ts \
  --dataset /mnt/mw/corpus/heldout/heldout-dev-v0.7.10-gb-county.json \
  --baseline /mnt/mw/tmp/heldout-replay/cache/v7100 \
  --candidates /mnt/mw/tmp/heldout-replay/cache/v720,/mnt/mw/tmp/heldout-replay/cache/v440 \
  --out /mnt/mw/tmp/heldout-replay/run/report.json
```

Run times (observed): scoring 22:30:59Z to 22:45:36Z, 14 min 37 s for 26,610 rows × 3 arms, about 5 min per arm.
Each evaluation finished within one second. Observed: the scorer refused no arm. No locale package reported an unfed
channel, and no package was missing.

### Per-country exact-parse rates

Observed: these are address rows for the nine required countries. A group counts as exact when all its rows parse
exactly. The evaluator reported no bound, because no row was admitted. The bounds below are computed from
`report.json` by `clopperPearson` (`release/bounds.ts`) at v6's per-tail level, `adjustedPercentile(0.95, 15,
bonferroni)` = 0.001667, the same functions and level the evaluator would use. The computation is
`scratchpad/2026/10/20/replay/table.ts`. Inferred: this computation is outside the evaluator, so it describes the
data and carries no verdict. Its IT, AU and NZ upper limits at 100% equal the record's best-possible values above
(0.119, 0.819, 0.796), which checks the level.

| Country |  Min | Groups | v7100 (10.7.0) exact [lower, upper] | v720 (10.1.0–10.6.0) exact [lower, upper] | v440 (9.1.0–10.0.0) exact [lower, upper] |
| ------- | ---: | -----: | ----------------------------------- | ----------------------------------------- | ---------------------------------------- |
| US      | 0.60 |    999 | 0.757 [0.715, 0.795]                | 0.762 [0.720, 0.800]                      | 0.666 [0.620, 0.709]                     |
| FR      | 0.90 |    999 | 0.949 [0.925, 0.967]                | 0.946 [0.922, 0.965]                      | 0.941 [0.916, 0.961]                     |
| GB      | 0.80 |  1,000 | 0.435 [0.389, 0.482]                | 0.417 [0.371, 0.464]                      | 0.426 [0.380, 0.473]                     |
| DE      | 0.85 |  1,000 | 0.990 [0.977, 0.997]                | 0.989 [0.975, 0.996]                      | 0.983 [0.967, 0.993]                     |
| IN      | 0.50 |  1,000 | 0.502 [0.455, 0.549]                | 0.485 [0.438, 0.532]                      | 0.084 [0.060, 0.113]                     |
| ES      | 0.80 |    180 | 0.967 [0.907, 0.993]                | 0.000 [0.000, 0.035]                      | 0.000 [0.000, 0.035]                     |
| IT      | 0.80 |      3 | 1.000 [0.119, 1.000]                | 1.000 [0.119, 1.000]                      | 1.000 [0.119, 1.000]                     |
| AU      | 0.80 |     32 | 0.938 [0.710, 0.998]                | 0.938 [0.710, 0.998]                      | 1.000 [0.819, 1.000]                     |
| NZ      | 0.80 |     28 | 1.000 [0.796, 1.000]                | 1.000 [0.796, 1.000]                      | 0.821 [0.537, 0.968]                     |

The exact-parse rate is a row rate. US and FR each have one group of two rows, so their group rate is one group lower.
v720 and v440 are old graphs with 10.7.0 overlays and their own en-us cards (inferred confound, see "Models staged"),
not the packages as they shipped. Observed: every one of ES's 180 rows is `spliced-sub-venue`, AU's 32 and NZ's 28 are
all `invented-po-box-cedex`, and IT's 3 are `spliced-affix` (2) and `spliced-country` (1). These countries therefore
measure one capability source each rather than the country's address forms. Inferred: ES at 0.000 for both older graphs means
they lack the sub-venue split that 10.7.0 learned. It does not show an ES regression. The scorer's printed table covers
all 104 cells, including the gazetteer cells, and is in `score.log`.

### Rows by locale package

Observed, the same in each verdict: en-us 19,367, de-de 2,000, fr-fr 2,000, en-gb 2,000, en-in 1,000, es-es 180,
en-au 32, en-nz 28, it-it 3. The total is 26,610. Countries without a shipped package go to en-us.

### Verdicts, spec v6

Every row is `unknown` (observed: 22,610 address rows in the `unknown` class, and the 4,000 gazetteer rows sit outside the
provenance table). v6 admits `verified_unseen` and `unseen_by_candidate` to minimum checks and only `verified_unseen` to
comparative checks. `known_overlap` and `unknown` are admitted to neither.

1. v720 candidate vs v7100 published. Observed: `insufficient_evidence`. Global reason: "the candidate artifact
   identity is unregistered". Each of the 15 checks reads 0 rows and 0 groups, and each is `insufficient_evidence`:
   - `country-US`, `-FR`, `-GB`, `-DE`, `-IN`, `-ES`, `-IT`, `-AU`, `-NZ` (minimum, thresholds 0.60, 0.90, 0.80,
     0.85, 0.50, 0.80, 0.80, 0.80, 0.80): `no admitted rows; required country XX has no admitted rows`.
   - `po_box_cedex` minimum (0.85): "no admitted rows".
   - `po_box_cedex` max_loss (−0.05): `no admitted rows; po_box_cedex holds fewer than two independent units, so its variance cannot be estimated`.
   - `venue_unit`, `country_token`, `postal_unit` minimum (0.85): "no admitted rows".
   - `objective` (0.0000): "no admitted rows", plus the nine required-country reasons.
   - Descriptive Q over the `unknown` class: published 0.8375, candidate 0.7263.
2. v440 candidate vs v7100 published. Observed: `insufficient_evidence`, with the same global reason and the same 15
   check outcomes and reasons as verdict 1. Descriptive Q over `unknown`: published 0.8375, candidate 0.6579.
3. v7100 candidate vs v720 published. Observed: refused with exit 1 before writing a verdict: `Error: the published artifact
   sha256 5764c2fb405bcce8ab2efe51075e9bcc1ffa234c76b8f1fd9ad9995c742c7fb9 does not match the registered
   e90aeab4b07d03a5b599331c1e68aa70d37e96478151795bcdc6dabb82d9aca9`. v6 registers 10.7.0 as the published model.

Observed artifact sha256: v7100 `e90aeab4…d9aca9`, v720 `5764c2fb…2c7fb9`, v440 `91c34f0e…8ca0c6`.

Inferred: the candidate identity reason would block a pass on its own even with admitted rows, since v6's candidate
`sha256` is `null`. The table above suggests that with admitted rows, all three models would fail GB (upper limit below
0.80) on this dataset. IT would read insufficient evidence for any model, and v440 would fail IN and ES.

## Not run

- Overlap audit: not requested. Observed estimate: the manifest's 859 train files total 78.8 GB, which is under the
  100 GB ceiling. Test and val files add 0.36 GB each.

## Problems found in the tools and the corpus

1. Observed: the corpus repeats records. Among the 3,180,659 rows of the v0.7.10-gb-county test split there are
   2,864,084 distinct `<source>:<source_id>` values, with rows that lack an id counted once per source. `ban` writes 311,727 ids twice with identical text, because
   `corpus-v0.7.0-de-holdout/test/part-0000.parquet` and `part-0001.parquet` hold the same rows and both are listed.
   `rendered-de`, `rendered-gb-os-open`, `rendered-fr-admin-split`, `invented-house-venue` and `usgov-imls-pls` write
   several texts under one id. The freeze refused both kinds (`two sampled rows share the identity …`). Fixed: the
   sampler now reads one row per record, the first in sample order, for both the sample and the availability counts.
   `heldoutRowID` stays `<source>:<source_id>`, the key the overlap audit joins training rows on. A change that hashed
   the text into the identity broke the audit's join and was reverted.
2. Observed: the rows file was written in DuckDB's run-dependent window order. Two freezes of one sample recorded
   different rows sha256 values over the same sorted row set. Fixed: the sample query now has an `ORDER BY`.
3. Observed: the dataset version did not change when the sampler's membership rule changed (`d44adaed98bef74f` before
   and after fix 1, with different rows). The version hashes the sampling rule, and the method name had not changed.
   Fixed: the method is now `per-record-country-kind-hash-order`. Unfixed: any later change to the sampler code must
   rename the method by hand, or the version will not change.
4. Observed: `freeze.run.ts` opened DuckDB at its default memory share of host memory. Fixed: it now takes
   `--duckdb-memory-gib` and `--duckdb-threads`.
5. Observed: spec v6's grouping assumption says the dataset quota counts groups against 1,000 per country, but
   the sampler counts rows. US and FR sampled 1,000 rows over 999 groups. Unfixed.
6. Observed: `stage-candidate-cache.run.ts` only links files and has no copy mode. It also reports `calibration.json`
   and `calibration-per-locale.json` as absent from the data root, so a staged cache lacks files that the published
   package carries. Unfixed.
7. Observed: the two tools disagree about what an arm is. `per/country.run.ts` takes a cache root, which holds
   `node_modules/@mailwoman/neural-weights-*`, and writes that root as the report's arm. `evaluate.run.ts` must name
   the same arm string and hashes `<arm>/model.onnx`, which a cache root lacks. Worked around in the cache with the
   tools left unchanged: each cache root got a hard link to its `neural-weights-en-us/model.onnx`
   (`scratchpad/2026/10/20/replay/link-models.ts`). Unfixed in the tools. Inferred: the evaluator should resolve the
   en-us package's `model.onnx` under the arm root.
8. Observed: the evaluator's verdict line names only the candidate identity, but the checks also fail for want of
   admitted rows. A verdict that reads `insufficient_evidence` has no explanation in its global reasons. That
   explanation appears only in the per-check reasons.
