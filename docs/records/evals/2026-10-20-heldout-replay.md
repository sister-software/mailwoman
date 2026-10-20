# Held-out replay on v0.7.10-gb-county: development dataset frozen, scoring blocked

Date: 2026-10-20. Issue #2763. Policy: `scratchpad/2026/10/20/D_RULE_REDESIGN-confirmed.md`. Tools:
`packages/mailwoman/tools/eval-harness/heldout/` and `release/` on branch `heldout-replay`, cut from `origin/main`
34b72e60e. Each claim is marked observed, inferred, decided, or unknown.

## Outcome

Observed: the development dataset froze. Scoring did not run, so no exact-parse rate, Clopper–Pearson bound or release
verdict exists for any model. Observed: the worktree resolves every `@mailwoman/*` package through the main checkout,
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
| Sampling               | `per-record-country-kind-hash-order`, 1,000 per country and kind, seed 2763, DuckDB v1.5.6    |

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
shipped with, taken from git at 321d2bf76~1 and fa328896e~1. Every overlay file (FST, pair indexes, postcode tables,
lexicons) comes from the current data root, which is the 10.7.0 set. A score for an older arm would therefore
measure that graph with 10.7.0 overlays rather than the package as it shipped (inferred confound). The 10.4.0 package
carries the v720 graph, so it adds no third graph.

## Not run

- `per/country.run.ts`: blocked as described above.
- `release/evaluate.run.ts` with spec v6: it reads the per-country report that the blocked step writes. Expected
  verdict once it runs, with every row `unknown`: insufficient evidence on every check, because v6 admits only
  `verified_unseen` and `unseen_by_candidate` (inferred from `provenance.admitted`).
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
5. Observed: spec v6 says "the dataset quota counts groups, not rows, against 1,000 per country", but the sampler
   counts rows. US and FR sampled 1,000 rows over 999 groups. Unfixed.
6. Observed: `stage-candidate-cache.run.ts` only links files and has no copy mode. It also reports `calibration.json`
   and `calibration-per-locale.json` as absent from the data root, so a staged cache lacks files that the published
   package carries. Unfixed.
