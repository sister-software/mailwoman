# `mailwoman/data/` provenance

## `published-bundles.json` — what the public bucket serves for each bundle

Written by `node packages/mailwoman/tools/dev-tools/data/published-bundles.run.ts`, which sends a HEAD
request for every artifact in `BUNDLES` (`lib/data/bundles.ts`) and records the `content-length` the
bucket reports, then reads the `layer_manifest` of the local copy under `$MAILWOMAN_DATA_ROOT` for its
tier and flat license expression. The command generates the file. To change it, rerun the command and commit the
result rather than editing it by hand.

A reader checks it with `yarn mwops health published-bundles`, which compares each artifact's
`contentLength` against the registry's `approxBytes` and reports a bundle the snapshot does not cover.
`measuredAt` is the instant the writer ran, and the docs site renders it beside the table it draws from
this file.

A manifest recorded as `unmeasured` names the reason: no local copy, or a local copy whose size differs
from the published artifact's. A size difference means the copy is another build, and its manifest
describes that build rather than the published one. Each bundle's `rights` record, the database-level license and the
per-component list counsel asked for, is written as unmeasured and empty until a reader can measure
it. Neither is derived from the flat expression.

## `coarse-placer/` — the country classifier behind the default soft country prior

`meta.json` and `weights.bin`: a multinomial logistic-regression classifier over 29 country classes
on a 65,536-dimension hashed character-n-gram feature space, with a single temperature fitted on the
validation split. Written by `mailwoman placer train`
(`packages/core/tools/coarse-placer/train.ts`). It is first-party work, so no third-party license
attaches to the artifact itself. `loadBundledCoarsePlacer` (`lib/default/placer.ts`) reads it, and
`$MAILWOMAN_COARSE_PLACER_DIR` replaces it. The package's `files` array ships it.

Its training rows are assembled by `mailwoman placer build-dataset`
(`packages/core/tools/coarse-placer/build/dataset.ts`) into
`<repo>/data/coarse-placer/{train,val,test}.jsonl`. Those files are **not committed**, and the directory
holds 0 tracked files. On this machine they hold 1,165,072 training rows, 145,629 each for
validation and test, plus 11,209 in `test-latin-offmap.jsonl`. Each row is `{raw, country}` and
has no source field, so which publisher an address came from cannot be recovered from the dataset.

The builder reads three inputs, all under the data root and none committed:

- `corpus/versioned/v0.5.0/corpus-v0.5.0/train/*.parquet`, sampled per country because a flat sample
  is 94% US and FR
- `corpus/versioned/…/corpus-v0.9.2-multilocale-au/…/*.parquet`, for Australian rows
- `overture/2026-06-17.0`, pinned as `OVERTURE_ADDRESSES_RELEASE` in `core/lib/overture-pins.ts`

**Unrecorded, and the largest gap in this record:** which records trained the committed `weights.bin`.
The builder reads a corpus version and the shipped artifact records no manifest, so the artifact
cannot be joined to the rows behind it. It is the same gap the twelve `neural-weights-*` packages
have, and `docs/engineering/reference/artifact-rights-inventory.mdx` tracks both. A rebuild would
close it by freezing a manifest the way `buildCorpus` now writes `TRAINING_SOURCES.json`.

## `county-population-ranked.json` — US counties ranked by population

Read by `lib/commands/situs/interpolation/index.tsx` as `RANKED_FILE`. It moved here from the retired
root `scripts/data/` directory (`docs/superpowers/specs/2026-07-07-scripts-drawer-to-zero.md`), and no
command in this repository regenerates it. An edit to it is a hand change to a record whose writer is
not on file.
