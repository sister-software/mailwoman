# `mailwoman/data/` provenance

## `published-bundles.json` — what the public bucket serves for each bundle

Written by `node packages/mailwoman/lib/dev-tools/data/published-bundles.run.ts`, which sends a HEAD
request for every artifact in `BUNDLES` (`lib/data/bundles.ts`) and records the `content-length` the
bucket reports, then reads the `layer_manifest` of the local copy under `$MAILWOMAN_DATA_ROOT` for its
tier and flat license expression. Generated, **not hand-edited**: rerun the command and commit the
result.

A reader checks it with `yarn mwops health published-bundles`, which compares each artifact's
`contentLength` against the registry's `approxBytes` and reports a bundle the snapshot does not cover.
`measuredAt` is the instant the writer ran, and the docs site renders it beside the table it draws from
this file.

A manifest recorded as `unmeasured` names the reason: no local copy, or a local copy whose size differs
from the published artifact's, which means the copy is another build and its manifest says nothing
about the published one. Each bundle's `rights` record, the database-level license and the
per-component list counsel asked for, is written as unmeasured and empty until a reader can measure
it. Neither is derived from the flat expression.

## `county-population-ranked.json` — US counties ranked by population

Read by `lib/commands/situs/interpolation/index.tsx` as `RANKED_FILE`. It moved here from the retired
root `scripts/data/` directory (`docs/superpowers/specs/2026-07-07-scripts-drawer-to-zero.md`), and no
command in this repository regenerates it. An edit to it is a hand change to a record whose writer is
not on file.
