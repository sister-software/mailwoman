# `core/data/` — what each directory holds and what wrote it

`@mailwoman/core` is installed by every consumer of Mailwoman, and its `files` array ships `data/**`
whole. This file records what is in there, which builds it, and what about it is unrecorded.

Four directories, and the third-party notices describe three. `THIRD_PARTY_NOTICES.md` beside this
file is the copy npm ships, and it carries the terms. This file carries the build path, which is a
different question: what wrote the bytes, and whether a reader can check them.

## The `data-provenance` check does not read this file's directory

The check collects files whose directory equals a `data/` directory and reports each one the
directory's `PROVENANCE.md` does not name. It is non-recursive, and every artifact here sits a level
down. So committing this file brings `packages/core/data/` into the check's scope, and the check then
finds zero artifacts to name and passes.

That is stated here rather than left for a reader to assume the opposite. The record is what a reader
opens; the check does not stand behind it yet, and making it recursive is a change to the check rather
than to this file.

## What is here

| directory                | files | what it is                                               |
| ------------------------ | ----: | -------------------------------------------------------- |
| `libpostal/`             |   825 | Vendored libpostal dictionaries, 61 language directories |
| `chromium-i18n/`         |   253 | Google libaddressinput per-country address metadata      |
| `internal/dictionaries/` |    34 | Curated tables this repository maintains                 |
| `coarse-placer/`         |     2 | A trained first-party classifier                         |

### `libpostal/`

Fetched by `mailwoman dev download libpostal-resources`
(`packages/core/lib/tools/download/libpostal-resources.ts`). Upstream is
[libpostal](https://github.com/openvenues/libpostal), MIT, © 2015 openvenues, and the license text is
vendored at `libpostal/LICENSE`.

`libpostal/README.md` records which files still have a code consumer and which do not. It was audited
2026-08-01 and says so, because the consumer map moved when the rules parser was deleted in v7.0.0.

### `chromium-i18n/`

Fetched by `mailwoman dev download ssl-address`
(`packages/core/lib/tools/download/ssl-address.ts`), from
`chromium-i18n.appspot.com/ssl-address/data/<CC>`, one file per country code. Upstream is Google's
[libaddressinput](https://github.com/google/libaddressinput), Apache-2.0, and the license text is
vendored at `chromium-i18n/LICENSE`.

The fetch takes the country list from `…/ssl-address/data` as a `~`-delimited string, so a country
added upstream appears on the next run rather than needing a list edited here.

### `internal/dictionaries/`

Curated here rather than fetched, which is what `internal` names.

`languages.csv` is the ISO 639 table `generateLanguageTypes`
(`packages/core/lib/tools/generate-language-types.ts`) reads to regenerate
`core/lib/resources/languages/types.gen.ts`. Editing the CSV without re-running that tool leaves the
committed types describing an older table.

`libpostal/` under this directory holds curated overrides and additions that sit apart from the
vendored copy above, so a re-fetch of upstream cannot overwrite them.

`whosonfirst/` holds three preferred-name lists derived from Who's On First, at
`whosonfirst/locality/name:eng_x_preferred.txt`, `whosonfirst/locality/name:fra_x_preferred.txt` and
`whosonfirst/region/name:eng_x_preferred.txt`. Who's On First's own terms make crediting the project
recommended and linking back to the license required; the text as retrieved is archived at
`packages/corpus/data/licenses/whosonfirst-licenses.md`.

**Unrecorded:** which Who's On First release those three files were derived from, and which command
derived them. They entered the tree in `25709e568` as part of a rename, so that commit is not their
origin.

### `coarse-placer/`

`meta.json` and `weights.bin`: a multinomial logistic-regression classifier over 29 country classes
on a 65,536-dimension hashed character-n-gram feature space, with a single temperature fitted on the
validation split. Written by `mailwoman placer train`
(`packages/core/lib/coarse-placer/tools/train.ts`). It is first-party work, so no third-party license
attaches to the artifact itself.

Its training rows are assembled by `mailwoman placer build-dataset`
(`packages/core/lib/coarse-placer/tools/build/dataset.ts`) into
`<repo>/data/coarse-placer/{train,val,test}.jsonl`. Those files are **not committed** — the directory
holds 0 tracked files — and on this machine they carry 1,165,072 training rows, 145,629 each for
validation and test, plus 11,209 in `test-latin-offmap.jsonl`. Each row is `{raw, country}` and
carries no source field, so which publisher an address came from cannot be recovered from the dataset.

The builder names three inputs, all under the data root and none committed:

- `corpus/versioned/v0.5.0/corpus-v0.5.0/train/*.parquet`, sampled per country because a flat sample
  is 94% US and FR
- `corpus/versioned/…/corpus-v0.9.2-multilocale-au/…/*.parquet`, for Australian rows
- `overture/2026-06-17.0`, pinned as `OVERTURE_ADDRESSES_RELEASE` in `core/lib/overture-pins.ts`

**Unrecorded, and this is the gap worth naming:** which records trained the committed `weights.bin`.
The builder reads a corpus version and the shipped artifact records no manifest, so the artifact
cannot be joined to the rows behind it. It is the same gap the twelve `neural-weights-*` packages
carry, and `docs/engineering/reference/artifact-rights-inventory.mdx` tracks both. A rebuild would
close it by freezing a manifest the way `buildCorpus` now writes `TRAINING_SOURCES.json`.
