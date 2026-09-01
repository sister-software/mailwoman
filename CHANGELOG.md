# Changelog

All notable changes are recorded here at a high level. For the full,
authoritative mapping of **which npm version shipped which model and which
capabilities**, see [`docs/articles/releases.mdx`](./docs/articles/releases.mdx)
(rendered at https://mailwoman.ai/releases). Per-release detail
lives in the [GitHub releases](https://github.com/sister-software/mailwoman/releases)
and the per-step eval reports under `docs/articles/evals/`.

## Versioning

All publishable workspaces release **in lockstep** — `mailwoman@4.15.0` pairs
with `@mailwoman/neural-weights-en-us@4.15.0` and every other `@mailwoman/*`
package at the same version. Since `4.0.0`, the npm version is the one that
matters to consumers. The format follows [Keep a Changelog](https://keepachangelog.com)
loosely and [Semantic Versioning](https://semver.org); the public API is still
settling, so treat `4.x` as pre-stable.

## Unreleased

### Breaking — `@mailwoman/spatial` drops its `./sdk` subpaths

`@mailwoman/spatial/sdk`, `@mailwoman/spatial/sdk/ogr` and `@mailwoman/spatial/sdk/well-known-text` are **removed
outright**, with no deprecated re-export. Replacements:

| Removed                                  | Use                                  |
| ---------------------------------------- | ------------------------------------ |
| `@mailwoman/spatial/sdk/well-known-text` | `@mailwoman/spatial/well-known-text` |
| `@mailwoman/spatial/sdk/ogr`             | `@mailwoman/spatial/tools/ogr`       |
| `@mailwoman/spatial/sdk` (barrel)        | import the module you want, by name  |

`sdk/` in this repository means **data acquisition** (`AGENTS.md`), and neither module acquires anything: one is a
pure WKT/WKB codec, the other shells out to `ogrinfo` to read what a source declares about itself. The barrel is not
replaced by a combined entry on purpose — `@mailwoman/spatial` is imported by browser-facing packages, the root
barrel deliberately excludes both modules, and a combined subpath would put a `node:child_process` reach one
`export *` away from a browser graph.

### Breaking — the provider region databases stop being called "shards"

`mailwoman/geocode-shards` becomes `mailwoman/geocode-regions`. The identifiers move with it:
`ShardProvider` → `RegionDatabaseProvider`, `BANShardProvider`/`OSMShardProvider` →
`BANRegionDatabaseProvider`/`OSMRegionDatabaseProvider`, `StateShards` → `RegionDatabases`,
`ShardResolver` → `RegionDatabaseResolver`, `ShardLookupFactory` → `RegionDatabaseFactory`,
`ShardCacheEntry` → `RegionDatabaseCacheEntry`. `@mailwoman/ban` and `@mailwoman/osm` rename
`sdk/shard-provider` to `sdk/region-database-provider`.

First slice of removing the word `shard`, which is going because it stood for four different things at once.
There is no replacement synonym: each site takes the noun for the thing it names, and this one routes
per-region address-point and interpolation databases. No shims.

### Breaking — `@mailwoman/filer` moves three domain modules out of `./sdk/`

`@mailwoman/filer/sdk/frn`, `@mailwoman/filer/sdk/family-rollup` and `@mailwoman/filer/sdk/filer-lookup` become
`@mailwoman/filer/frn`, `@mailwoman/filer/family-rollup` and `@mailwoman/filer/filer-lookup`. No shims. All three
are also re-exported from the package root, so `@mailwoman/filer` itself keeps resolving them.

They are identity and corporate-family readers, not acquisition — and they were exactly the symbols a request path
needed: `@mailwoman/mcp`'s CLI imported `familyRollup`, `filerLookup`, `toFRN` and `FRN` from the `./sdk` barrel,
which `export *`s seventeen modules, so an MCP request path carried the SEC and CORES HTTP clients and the EDGAR
ingest along to reach three functions. That import now names the three modules, and `dependency-cruiser`'s
`no-serve-package-to-build-tooling` counts `mcp` as a serve package so the edge cannot come back.

The rest of `filer/lib/sdk/` and all of `bdc/lib/sdk/` are unchanged: no serve path reaches them, and renaming them
would spend published subpaths on a naming preference rather than a measured violation.

## Notable releases

### 4.15.0 — postcode-anchor fix (`v1.9.3a3-anchor-absorption`)

A leading 5-digit token that is actually a US house number which happens to
look like a ZIP (`12345 Main St`) is now labeled `house_number` with the
postcode anchor on (the `SLICE-H` case: 20 → 100), at zero coordinate cost
(#220/#723). Trades a coordinate-invisible −2 us.postcode label-F1 on the rare
leading-postcode (VT E911) case.

### 4.14.0 — Australian word-order (`v1.9.2-multilocale-au`)

G-NAF-driven AU support; AU @25 km resolve rate 65 → 87.

### 4.11.0 — French admin split (`v1.8.0-fr-admin-split`)

First model to beat `v1.5.0` on the **shipped assembled coordinate** (not
label-F1) by teaching the locality↔adjacent-admin-token split on non-US
formats. FR coord p50 42 → 2.2 km; US flat.

### 4.4.0 — boundary consolidation

Closed the parity campaign's last empty tags — `po_box` 0 → 89, `cedex` 0 → 96,
intersections 0 → 100 (real-OOD) — and gated the perturbation arena floor.

### 4.2.0 — gazetteer-anchored consolidation

Locality / region lifts and `country` 0 → 89.8 via the gazetteer soft anchor;
the late-emergent affix tags born.

### 4.1.0 — unit designators

`unit` 0 → 92.3 on real-OOD designators — the first parity-campaign headline.

### 4.0.0 — first neural release

The retrieval-augmented neural sequence labeler ships as the default parser,
replacing the v0 rule engine on noisy/degraded input.

---

_Earlier `2.x`/`3.x` releases predate the neural rewrite; see the GitHub
releases for that history._
