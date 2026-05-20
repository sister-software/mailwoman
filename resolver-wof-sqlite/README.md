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
	console.log(c.wof_id, c.name, c.country, c.lat, c.lon, "score:", c.score)
}

lookup.close()
```

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
- Populates it from `places` + `names` (alternate-name concatenation included).
- Reports progress to stderr per phase (`checking` → `creating` → `populating` → `done`).
- Exits 0 with a no-op message if the index already exists.

```bash
# Refresh after pulling a newer WOF dump
npx mailwoman-wof-build-fts /path/to/wof.db --drop
```

`--drop` rebuilds from scratch — useful after refreshing the `places` / `names` tables from a newer dump. Without `--drop` the CLI is a no-op when the index is already present.

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
6. − `lengthPenaltyWeight` × excess-length penalty (favors short matches over long matches on short queries).

All weights are configurable via the second ctor argument:

```ts
new WofSqlitePlaceLookup({ databasePath }, { countryMatchBoost: 0.5 })
```

Defaults are in `lookup.ts::DEFAULT_WEIGHTS`.

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
