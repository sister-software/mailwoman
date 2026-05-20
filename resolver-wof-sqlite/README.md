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
2. **Pre-build the index** — run the build once via your own script (`db.exec("CREATE VIRTUAL TABLE place_search ..."); db.exec("INSERT INTO place_search SELECT ...")`) and ship the DB with the index included. Faster startup for production.

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

## Concurrency model

This package opens a single `node:sqlite` connection per `WofSqlitePlaceLookup` instance. SQLite is single-writer / many-reader; the Kysely wrapper around the connection serializes all queries through a mutex. For high-concurrency HTTP servers, instantiate one resolver per request handler or per pool slot — sharing a single instance across concurrent requests is fine (queries queue) but won't parallelize across cores.

## License

AGPL-3.0. WOF data: CC-BY 4.0 (see Attribution above).
