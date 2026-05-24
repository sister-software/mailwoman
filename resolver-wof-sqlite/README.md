# @mailwoman/resolver-wof-sqlite

FTS5-backed [Who's On First](https://whosonfirst.org/) SQLite resolver for [mailwoman](https://www.npmjs.com/package/mailwoman). Takes free-text place queries (`"Paris, FR"`, `"Springfield, IL"`) and returns ranked candidate place IDs + coordinates from a WOF SQLite distribution on disk.

Phase 4.2 of the mailwoman neural-resolver plan — see [`docs/plan/phases/PHASE_4_2_wof_sqlite.md`](https://github.com/sister-software/mailwoman/blob/main/docs/plan/phases/PHASE_4_2_wof_sqlite.md) in the source repo.

## Installation

```bash
npm install @mailwoman/resolver-wof-sqlite
```

Requires Node 22+ for built-in `node:sqlite`.

## Quick start

```ts
import { WofSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

const lookup = new WofSqlitePlaceLookup({
	databasePath: "/path/to/whosonfirst-data-admin-us-latest.db",
	buildFts: true, // build the FTS5 index on first open (one-time cost)
})

const candidates = await lookup.findPlace({
	text: "Springfield",
	placetype: "locality",
	country: "US",
})

for (const c of candidates) {
	console.log(c.id, c.name, c.country, c.lat, c.lon, "score:", c.score)
}

lookup.close()
```

## Multi-shard (admin + postcode in one connection)

Pass an array of paths to open multiple WOF shards on a single connection — each is opened as a
separate SQLite schema via `ATTACH DATABASE`. Schema names auto-derive from filenames
(`whosonfirst-data-admin-us-latest.db` → `admin_us`, `whosonfirst-data-postalcode-us-latest.db` →
`postalcode_us`). Queries route by `placetype` — a `postalcode` query goes to the
`postalcode_us` shard automatically, everything else hits main.

```ts
const lookup = new WofSqlitePlaceLookup({
	databasePath: ["/data/wof/whosonfirst-data-admin-us-latest.db", "/data/wof/whosonfirst-data-postalcode-us-latest.db"],
})

await lookup.findPlace({ text: "Springfield", placetype: "locality" }) // → admin shard
await lookup.findPlace({ text: "62701", placetype: "postalcode" }) // → postcode shard
```

Override schema names or routing explicitly when needed:

```ts
new WofSqlitePlaceLookup({
	databasePath: ["/data/wof/admin.db", { path: "/data/oddly-named.db", schemaName: "pc", placetypes: ["postalcode"] }],
})
```

Cross-shard `UNION` queries are not supported in one `findPlace` call — BM25 scores aren't
comparable across separately-indexed corpora. Issue two `findPlace` calls and merge in your
caller if you need that.

## Getting the WOF SQLite distribution

The Geocode Earth team mirrors WOF SQLite distributions at <https://data.geocode.earth/wof/dist/sqlite/>. The two relevant shards for v1:

| Distribution                                   | Size (bz2) | Use                                                               |
| ---------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| `whosonfirst-data-admin-us-latest.db.bz2`      | ~845 MB    | US administrative places (country / region / locality / borough). |
| `whosonfirst-data-postalcode-us-latest.db.bz2` | ~320 MB    | US postcodes.                                                     |

```bash
curl -L -o whosonfirst-data-admin-us-latest.db.bz2 \
  https://data.geocode.earth/wof/dist/sqlite/whosonfirst-data-admin-us-latest.db.bz2
bunzip2 whosonfirst-data-admin-us-latest.db.bz2
```

## FTS5 index

Upstream WOF SQLite distributions ship a `places` table but **not** an FTS5 index. The resolver needs FTS5 to do fast prefix + token-bag matching. Two options:

1. **`buildFts: true` on construction** — builds the index lazily on first open. Cost is one-time but expensive (~minutes on the full US admin shard). Use for prototyping.
2. **Pre-build the index with `mailwoman-wof-build-fts`** — ship the DB with the index included so first-open is fast. Recommended for production.

### `mailwoman-wof-build-fts` CLI

A one-shot operator script ships with this package as a `bin`:

```bash
npx mailwoman-wof-build-fts /path/to/whosonfirst-data-admin-us-latest.db
```

The CLI:

- Opens the DB read-write.
- Creates the `place_search` FTS5 virtual table (with the same schema the lazy build uses).
- Populates it from `spr` + `names` (alternate-name concatenation included).
- Builds the `place_bbox` R*Tree virtual table from `spr.min\_*`/`spr.max\_\*` columns for the
  proximity + bbox query support.
- Reports progress to stderr per phase (`checking` → `creating` → `populating` → `creating-bbox`
  → `populating-bbox` → `done`).
- Exits 0 with a no-op message if both indexes already exist.

```bash
# Refresh after pulling a newer WOF dump
npx mailwoman-wof-build-fts /path/to/wof.db --drop
```

`--drop` rebuilds from scratch — useful after refreshing the `places` / `names` tables from a newer dump. Without `--drop` the CLI is a no-op when the index is already present.

### `mailwoman-wof-build-slim` CLI

Builds a trimmed WOF SQLite distribution sized for browser-side deployments (Path B of the demo plan). The full admin-US distribution is ~4 GB; a slim US bundle with the top-1k localities by population plus all postcodes lands at **~35 MB** — small enough to ship as a static asset.

```bash
# Defaults: --top 1000 localities, --countries US, drops geojson after building aux tables
npx mailwoman-wof-build-slim \
  --in /path/to/whosonfirst-data-admin-us-latest.db \
  --in /path/to/whosonfirst-data-postalcode-us-latest.db \
  --out /path/to/wof-hot.db

# Tinier — top 100 localities only
npx mailwoman-wof-build-slim --in admin-us.db --out wof-tiny.db --top 100

# Multi-country
npx mailwoman-wof-build-slim --in admin-na.db --out wof-na.db --countries US,CA,MX
```

What survives in the slim DB:

- All ancestor placetypes (`country`, `region`, `county`, `borough`, `macroregion`) in scope
- Top-K localities by `wof:population`
- All postcodes in scope
- All `names` rows for the selected place IDs
- Fresh `place_search` (FTS5), `place_bbox` (R\*Tree), `place_population` aux tables

What gets dropped: the `geojson` table, which is build-time only — `lookup.ts` never reads it at query time, and it accounts for ~95% of the on-disk size. The `place_population` aux table consumes `wof:population` from geojson before we drop it.

`WofSqlitePlaceLookup` opens the slim DB without any code change. Out-of-set queries (a locality not in the top-K) correctly return zero hits.

You can also build the index programmatically via the package's `./fts` subpath:

```ts
import { DatabaseSync } from "node:sqlite"
import { buildPlaceSearchFts } from "@mailwoman/resolver-wof-sqlite/fts"

const db = new DatabaseSync("/path/to/wof.db")
const { created, indexedRows, durationMs } = buildPlaceSearchFts(db, {
	drop: false,
	onProgress: (phase, detail) => console.log(phase, detail),
})
db.close()
```

## Ranking

The resolver scores candidates by:

1. SQLite FTS5 BM25 (negated so higher = better).
2. - `placetypeMatchBoost` when the candidate's placetype matches the query filter.
3. - `localityImplicitBoost` when no placetype filter is set and the candidate is a locality.
4. - `countryMatchBoost` when the country filter matches.
5. - `directChildBoost` / `descendantBoost` when `parentId` is set.
6. - `proximityBoost / (1 + distanceKm / proximityScaleKm)` when `near: {lat, lon}` is set — decays
     smoothly with distance from the user's position. At distance 0 the boost is full magnitude; at
     `proximityScaleKm` (default 100 km) it's half.
7. − `lengthPenaltyWeight` × excess-length penalty (favors short matches over long matches on short
   queries).

## Geographic filters (Phase 4.3.x)

Two query options use the package-built R\*Tree index over WOF's bounding boxes:

```ts
// Proximity boost (no hard filter — distant candidates aren't dropped, just ranked lower)
lookup.findPlace({
	text: "Springfield",
	placetype: "locality",
	near: { lat: 39.78, lon: -89.65 },
})

// Proximity boost + hard filter — drop anything beyond 200 km
lookup.findPlace({
	text: "Springfield",
	placetype: "locality",
	near: { lat: 39.78, lon: -89.65, maxDistanceKm: 200 },
})

// Bbox hard filter — only return candidates whose bbox intersects the box
lookup.findPlace({
	text: "Springfield",
	placetype: "locality",
	bbox: { minLat: 37, maxLat: 42.5, minLon: -91.5, maxLon: -87.5 },
})
```

When the R*Tree index isn't present (DBs built before this feature), the bbox-hard-filter is
silently dropped to preserve backwards compatibility. The proximity boost still works without the
R*Tree because it computes haversine distance against the centroid columns directly. Rebuild with
`mailwoman-wof-build-fts --drop <path>` to gain the bbox index.

All weights are configurable via the second ctor argument:

```ts
new WofSqlitePlaceLookup({ databasePath }, { countryMatchBoost: 0.5 })
```

Defaults are in `lookup.ts::DEFAULT_WEIGHTS`.

## Query syntax

`FindPlaceQuery.text` accepts free-text input — apostrophes / parens / accented characters / etc.
are all stripped safely before going to FTS5. Per-token rules:

- **Bare tokens** (`"Paris"`, `"62701"`) become FTS5 **phrase matches**: `"Paris"` matches places
  named exactly "Paris", `"62701"` matches the postcode 62701 exactly.
- **Trailing `*`** (`"627*"`, `"Pari*"`) becomes FTS5 **prefix syntax**: `627*` matches every
  postcode starting with 627, `Pari*` matches Paris / Parishville / etc. The caller explicitly
  signals "prefix"; bare tokens stay phrase-matched for safety.
- **Multiple tokens** join with implicit AND: `"Pari* TX"` matches places whose name contains
  both a `Pari*`-prefixed word AND the word `TX`.

Example: `findPlace({ text: "902*", placetype: "postalcode" })` returns 90201, 90210, 90211, …
matching the Los Angeles ZIP corridor.

## Attribution (CC-BY 4.0)

Who's On First data is licensed [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). Downstream applications shipping resolved results from this package **must** carry an attribution notice — for example:

> Place data via [Who's On First](https://whosonfirst.org/) © Mapzen + contributors, CC-BY 4.0.

This package itself is AGPL-3.0; the WOF data it indexes is CC-BY 4.0. The two licenses are separate — your application must comply with both.

## Integration tests

`resolver-wof-sqlite/integration.test.ts` exercises the resolver against a real WOF SQLite distribution. The suite is **skipped** when no DB is present — set `MAILWOMAN_WOF_DB` to override the lookup path, otherwise it defaults to `/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db` (the canonical lab location). CI runs against the fixture-only suites; operators with real WOF data locally get an extra layer of validation.

Coverage includes: placetype filtering, country filtering, the empty-result case, FTS5 special-character sanitization, Japanese alt-name resolution, parent-constrained lookup, and a performance budget (`findPlace` < 250 ms against the 142 k-row US admin shard).

## Concurrency model

This package opens a single `node:sqlite` connection per `WofSqlitePlaceLookup` instance. SQLite is single-writer / many-reader; the Kysely wrapper around the connection serializes all queries through a mutex. For high-concurrency HTTP servers, instantiate one resolver per request handler or per pool slot — sharing a single instance across concurrent requests is fine (queries queue) but won't parallelize across cores.

## License

AGPL-3.0. WOF data: CC-BY 4.0 (see Attribution above).
