# Corpus build: source IDs during align, `--jobs K`, align ranges

Date: 2026-10-20 (runs) for the 2026-10-21 record. Branch `corpus-build-parallel`, from `origin/main` 3e632daac.
This record follows `CORPUS_BUILD_PARALLEL-review.md` and `CORPUS_BUILD_PROFILE.md` from the operator's 2026-10-20
scratchpad.

## What changed

1. Align writes each labeled row's `source_id` to `intermediate/source-ids-<split>.txt`, and the split phase
   sorts those lists instead of parsing `labeled-*.jsonl` again. The external sort is unchanged.
2. `corpus build --jobs K` runs each source as three worker processes: `adapter`, `align` and `finish`, which sorts
   the source's ids, writes its parquet and writes `SOURCE_COMPLETE.json` last. A coordinator assembles the
   corpus from the sources' records (`lib/build/parallel.ts`). `--jobs 1` is the serial build.
3. With `--jobs` above 1, a source's `canonical.jsonl` is divided at line starts into byte ranges (one per
   `--align-range-mib`, default 2048, at most `2K` ranges), and each range aligns in its own worker.
4. The parquet conversion runs DuckDB at one thread in both modes (see the finding below).

## Result: multi-threaded parquet conversion is not deterministic

Observed. One 1,000,000-row `ban` train part was exported to NDJSON and converted with the build's own
`COPY … (FORMAT PARQUET, ROW_GROUP_SIZE 50000)` and `preserve_insertion_order=true`, three runs at each thread
count:

| DuckDB threads | sha256 prefixes of 3 runs        |
| -------------- | -------------------------------- |
| 1              | `079c3e27` `079c3e27` `079c3e27` |
| 2              | `4eeb6af9` `94db0e20` `4eeb6af9` |
| 4              | `4eeb6af9` `4eeb6af9` `94db0e20` |
| 16             | `94db0e20` `94db0e20` `4eeb6af9` |

Rows and their order were identical in every file. Only the row-group boundaries moved (about 50,000 rows each, by
a few hundred rows). The serial build on `main` converts at DuckDB's default of one thread per core, so its store
files already differ between runs and between hosts. The conversion now sets `threads=1`. `writers.test.ts`
converts one staged part of 151,234 rows at instance limits 1, 2 and 4, twice each, and asserts one sha256. With
the `SET threads` line removed, the same test fails with two digests.

Consequence (decided). A branch build's train parts differ in bytes from a `main` build's. Every part with more
than one row group differs. Here that was 16 of 18 parts. Rows, row order, row counts, the first and last
source id of each part, the split files and every manifest field agree. Checked row by row on three parts
(`ban` train 0, `usgov-nppes` train 5, `state-tx-notaries` train 3): 0 rows differ in position or content.

## Measurement

Input: `state-tx-notaries` in full, `usgov-nppes` and `ban` at `limit: 1000000`, which gives 14,596,079 aligned
rows and 18 parquet parts. Host: lab, 16 cores, 29.2 GiB. The CI runners were idle. Each arm ran by itself with
`--fresh` and `--max-old-space-size=12288`, with no profiler. The `main` arm ran the main checkout at 3e632daac
through its compiled CLI. The branch arms ran this worktree at its final code. The harness sampled the process
tree's RSS once a second, and the temporary root and DuckDB spill every three seconds.

| Arm                                     | Elapsed | Peak RSS, sum over processes |       Peak RSS, largest process | Peak processes | Peak temp disk | `--out` size |
| --------------------------------------- | ------: | ---------------------------: | ------------------------------: | -------------: | -------------: | -----------: |
| `main`, serial                          |   568 s |                     4.32 GiB |                4.46 GiB (build) |              2 |       1.36 GiB |    14.01 GiB |
| branch `--jobs 1`                       |   518 s |                     2.47 GiB |                2.12 GiB (build) |              2 |       1.36 GiB |    14.48 GiB |
| branch `--jobs 3`                       |   408 s |                     4.32 GiB | 1.94 GiB (`usgov-nppes/finish`) |              5 |       1.20 GiB |    14.96 GiB |
| branch `--jobs 3 --align-range-mib 128` |   423 s |                     5.00 GiB |         1.84 GiB (`ban/finish`) |              5 |       1.64 GiB |    14.96 GiB |

The peak-process count includes the coordinator and `sort`. The `--out` growth is the source-id lists (0.47 GiB).
At `--jobs 3`, a parallel build also holds each source's sorted list and its own quarantine copy.

Before the single-thread conversion, at DuckDB's default threads, the same arms took `--jobs 1` 503 s,
`--jobs 3` 311 s and `--jobs 3` with ranges 266 s. Those builds wrote run-dependent bytes, so their timings
are kept only to show the cost of the fix. On this input the single-thread conversion costs about 15 s
serially and about 100 s at `--jobs 3`. There the `finish` tasks (the parquet writers) are the critical path
(`usgov-nppes/finish` 178 s, `ban/finish` 167 s).

Per-worker peaks at `--jobs 3` (from `WORKERS.json`, `process.resourceUsage().maxRSS`): adapters 1.45 to 2.02 GiB,
align 0.29 to 0.31 GiB, finish 1.81 to 1.94 GiB. The coordinator peaked at 0.44 GiB. Every worker reported a heap
ceiling of 6.1 GiB, the 6 GiB `--max-old-space-size` it was given.

Inferred: at 128 MiB, the ranges reduced align from 64 to 124 s per source to 21 to 32 s per range. The build got
slower overall because the `finish` tasks then ran three at once with no other work to overlap, and they contend
for the disk and CPU (`usgov-nppes/finish` went from 178 to 263 s). At this input size the ranges do not pay. They
are for sources whose align phase dominates, such as `usgov-nad`.

## Output equivalence

Observed. The comparator keys each part by its source, split and part number, and it re-hashes every file.

- Branch `--jobs 1` against `--jobs 3` and against `--jobs 3` with ranges: 18 of 18 parts identical in sha256,
  rows, bytes and first and last source id. The data records are identical except `builtAt`. `splits/train.txt`,
  `val.txt`, `test.txt` and `SPLIT_MANIFEST.json` are identical. The corpus `MANIFEST.json`, the top-level
  `MANIFEST.json`, `TRAINING_SOURCES.json` and `intermediate/quarantine.jsonl` are identical after the timestamp
  fields are removed.
- Branch against `main`: the split files, top-level manifest, `TRAINING_SOURCES.json` and quarantine file are
  identical. The 2 val and test parts are identical. The 16 train parts differ only in row-group layout, as
  described above.

Fields that may differ between two builds of one input: `built_at`, `adapters[].started_at`, `ended_at` and
`elapsed_ms`, every `builtAt`, `TRAINING_SOURCES.json` `contentDigest` and the manifest's
`training_manifest_digest`. The last two are sha256 values over a record that includes `builtAt`. Store paths and
`derivation_hash` differ between checkouts because the code hash covers the build modules. `align-checkpoint.json`,
`SOURCE_COMPLETE.json`, `RANGE_COMPLETE.json` and `WORKERS.json` are build state rather than corpus output.

## Failure and restart results

Covered by `packages/corpus/lib/build/parallel.test.ts`, all passing. The fixture has three sources (`wof-admin`,
`ban`, `usgov-hrsa-fqhc`), several parts each and a 5-row shuffle window. The tests cover:

- serial against `--jobs 2` and `--jobs 3`, and `--jobs 3` with 2 KiB ranges;
- cancellation while a source writes parquet, followed by `--resume`;
- an interruption between conversions, with a stray `data.parquet.partial.*` file present;
- a removed completion record, and a record over a missing part, each rebuilt from its source;
- a failed worker, where the other sources finish and `--resume` completes the build;
- a live lock (refused) and a dead owner's lock (taken over);
- `--jobs` over budget and a resident adapter that does not fit, both refused.

Every resumed build reaches the serial snapshot.

## Full-build prediction (inferred)

Scaled from the profile's serial phases (adapters 1 h 52 min, align 2 h 22 min, split 1 h 03 min, parquet
3 h 38 min, 659,387,048 rows):

- Serial with step 1: about 8 h. The split phase drops to the sort, about 8 min.
- The single-thread conversion adds an unmeasured share at full scale. On this input it added 3% serially.
- `--jobs 3` with align ranges: the critical path is `usgov-nad`, about 355 M rows. At this input's `finish`
  rate under contention (1 M rows in 18 to 24 s), its parquet write by itself takes 1 h 50 min to 2 h 20 min.
  Its adapter adds about 50 min (scaled from the v0.7.0 manifest, unmeasured), and its ranged align about 25 min.
  Predicted wall time: **3 h 15 min to 4 h**, against about 8 h serial. The profile's earlier estimate of 3 h
  assumed a multi-threaded conversion.
- The next reduction is the parquet `finish` of the largest source. Columnar batches would remove NDJSON
  staging (profile item 4), and a per-source parquet write split by part would need the shuffle window to stay
  within a part.

## Not run

- A full-scale build, and any build that includes `wof-admin`, `wof-postalcode`, `usgov-nad` or `tiger`. The
  resident 16 GiB worker class is unmeasured, and so is how much align ranges shorten `usgov-nad`'s align.
- Contention with live CI jobs.
- `yarn lint` and the full repository test suite. The corpus package's fast suite (2,025 tests), its integration
  suite and the CLI spec test ran and passed.
- A `--jobs 3` run on a host with another core count. The single-thread conversion is meant to make the bytes
  independent of the host, and that independence is untested across hosts.
