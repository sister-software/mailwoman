---
title: "The postcode-prefix index ships in the weights packages — the browser parse runs the anchor-region prior"
description: How the PFX1 postcode-prefix index travels from the data root into the en-US and en-GB weights packages, the dev overlay, the Hugging Face release directory and the browser loader, which scope stays out and why, what each runtime reads first, and the checks that ran.
---

# The postcode-prefix index ships in the weights packages — the browser parse runs the anchor-region prior

PR #2584 added the anchor-region prior reading the data root's `postcode-prefix` directory, so the
geocode session, the runtime pipeline, the gauntlet and the battery ran it and the browser runtime
did not. This record moves the index into the weights packages (#2585) so every runtime reads the
same artifact.

## The artifact

| scope    | file in the data root                   |  bytes | tier          | source                                  | ships |
| -------- | --------------------------------------- | -----: | ------------- | --------------------------------------- | ----- |
| `us`     | `postcode-prefix-us-2026-08-22.bin`     | 25,773 | `shipped`     | `postalcode-us.db` and the WOF polygons | yes   |
| `gb-esw` | `postcode-prefix-gb-esw-2026-08-05.bin` | 77,301 | `shipped`     | Code-Point Open, OGL v3.0               | yes   |
| `gb-ni`  | `postcode-prefix-gb-ni-2026-08-05.bin`  |  2,959 | `build-local` | OpenStreetMap, ODbL                     | no    |

A package ships a scope's index under the scope's own name, `postcode-prefix-us.bin` and
`postcode-prefix-gb-esw.bin`, and the data root keeps the dated builds. `release.config.json` lists
the scopes per country under `softFeed.postcodePrefixByCountry`. `mwops release copy-weights` copies
the newest dated file of each scope by modification time and refuses one whose PFX1 header records
tier `build-local`, so the Northern Ireland index cannot reach a package by a config edit alone. The
dev overlay linker links the same newest file under the shipped name, and `postcode-prefix-files.ts`
in `@mailwoman/core` is the one listing all of them read.

The builder `buildPostcodePrefixIndex` has no command-line caller in the tree, so the shipped bytes
are the prebuilt files and their headers record the build date and source digests. A rebuild path is
open.

## What each runtime reads

The Node weights resolver lists `postcode-prefix-*.bin` in the resolved package directory as
`postcodePrefixPaths`, the classifier exposes them, and `loadParsePriors` reads those before the
data-root directory. A checkout whose package directory holds no index still reads the data root,
and that fallback also reads the `gb-ni` build-local file, which is the dev posture the resolver's
own prefix prior has.

The browser loader takes `postcodePrefixURLs`, fetches each index beside the postcode binaries,
skips one that fails with a warning, and returns `anchorRegions`. The browser runtime passes it to
the pipeline, and the release manifest lists the files under `postcodePrefixes`, which the Hugging
Face publisher writes from its `postcodePrefixes` option. A release published before the field lists
none, and the prior stays off for it.

The anchor-region lookup now lives in `@mailwoman/neural` and derives a postcode's prefix from each
index's own `levels` header, `"3"` for a US sectional center and `"outward"` for a GB outward code,
so the browser needs no resolver package to build it.

## Checks

`mwops release copy-weights` ran on 2026-10-15 and wrote `postcode-prefix-us.bin` (25,773 bytes,
built 2026-08-22) into the en-US package and `postcode-prefix-gb-esw.bin` (77,301 bytes, built
2026-08-05) into the en-GB package, both from the data root's newest dated file. The weights
resolver then lists each as a package artifact, and the parse priors loader reads the package file
alone where it read the three data-root files before. The French overlay ships no index and still
reads the data-root directory.

Through the geocode session on that package file, the five rows of the #2582 record read the state
as a region and resolve to their postcodes, the same reading the data-root file gave: `05448 New St
Vermont`, `05478 Point Rd Vermont`, `82801 Cresent Pl Wyoming`, `05851 Lily Pond Rd Vermont` and
`82637 N Seventh St Wyoming`. `10 Downing St SW1A 2AA London` reads the same with the GB index
loaded, its anchor channel silent on that input.

The web loader test loads a serialized US index from a URL and answers `05448` with Vermont, skips a
404 with a warning while the classifier still loads, and loads no lookup when no index is listed.
The core listing test keeps the newest of two dated US files and lists none for an absent
directory. The rights role test reads `postcode-prefix-us.bin` as a postcode-prefix index rather
than a postcode binary. The resources test forms the index URL in the release directory. The
neural, core, geocode, browser-runtime and release-kit suites pass, 1,037 tests in 97 files, and
the regenerated `PROVENANCE.json` of each weights package records the new artifact with its digest
unrecorded, as the other derived binaries are.

## Cost

The published en-US package grows by 25,773 bytes and en-GB by 77,301. The browser cold load
fetches one more file beside the postcode binary, 25,773 bytes for the en-US release, against the
model's tens of megabytes.
