# `core/data/` — what each directory holds and what wrote it

`@mailwoman/core` is installed by every consumer of Mailwoman, and its `files` array ships `data/**`
whole. This file records the contents, the command that builds each directory, and what is unrecorded.

The directory has three subdirectories, and the third-party notices describe all three. `THIRD_PARTY_NOTICES.md`
beside this file is the copy npm ships, and it states the terms. This file records the build path. That is
a different question: what wrote the bytes, and whether a reader can check them.

## The `data-provenance` check does not read this file's directory

The check collects files whose directory equals a `data/` directory and reports each one the
directory's `PROVENANCE.md` does not name. It is non-recursive, and every artifact here sits a level
down. So committing this file brings `packages/core/data/` into the check's scope, and the check then
finds zero artifacts to name and passes.

That is stated here rather than left for a reader to assume the opposite. The record is what a reader
opens. The check does not verify it yet, and a recursive check is a change to the check rather
than to this file.

## What is here

| directory                | files | what it is                                               |
| ------------------------ | ----: | -------------------------------------------------------- |
| `libpostal/`             |   825 | Vendored libpostal dictionaries, 61 language directories |
| `chromium-i18n/`         |   253 | Google libaddressinput per-country address metadata      |
| `internal/dictionaries/` |    34 | Curated tables this repository maintains                 |

### `libpostal/`

Fetched by `mailwoman dev download libpostal-resources`
(`packages/core/tools/download/libpostal-resources.ts`). Upstream is
[libpostal](https://github.com/openvenues/libpostal), MIT, © 2015 openvenues, and the license text is
vendored at `libpostal/LICENSE`.

`libpostal/README.md` records which files still have a code consumer and which do not. It was audited
2026-08-01 and records that date, because the consumer map moved when the rules parser was deleted in v7.0.0.

### `chromium-i18n/`

Fetched by `mailwoman dev download ssl-address`
(`packages/core/tools/download/ssl-address.ts`), from
`chromium-i18n.appspot.com/ssl-address/data/<CC>`, one file per country code. Upstream is Google's
[libaddressinput](https://github.com/google/libaddressinput), Apache-2.0, and the license text is
vendored at `chromium-i18n/LICENSE`.

The fetch takes the country list from `…/ssl-address/data` as a `~`-delimited string, so a country
added upstream appears on the next run rather than needing a list edited here.

### `internal/dictionaries/`

These tables are curated here rather than fetched. The directory name `internal` marks that.

`languages.csv` is the ISO 639 table `generateLanguageTypes`
(`packages/core/tools/generate-language-types.ts`) reads to regenerate
`core/lib/resources/languages/types.gen.ts`. A CSV edit without a re-run of that tool leaves the
committed types describing an older table.

`libpostal/` under this directory holds curated overrides and additions that sit apart from the
vendored copy above, so a re-fetch of upstream cannot overwrite them.

`whosonfirst/` holds three preferred-name lists derived from Who's On First, at
`whosonfirst/locality/name:eng_x_preferred.txt`, `whosonfirst/locality/name:fra_x_preferred.txt` and
`whosonfirst/region/name:eng_x_preferred.txt`. Who's On First's own terms make crediting the project
recommended and linking back to the license required. The text as retrieved is archived at
`packages/corpus/data/licenses/whosonfirst-licenses.md`.

**Unrecorded:** which Who's On First release those three files were derived from, and which command
derived them. They entered the tree in `25709e568` as part of a rename, so that commit is not their
origin.

The trained coarse-placer classifier ships from the `mailwoman` package, and
`packages/mailwoman/data/PROVENANCE.md` records it.
