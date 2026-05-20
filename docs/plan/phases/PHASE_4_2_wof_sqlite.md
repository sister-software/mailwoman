# Phase 4.2 — WOF SQLite Loader

**Parent:** [`PHASE_4_resolver.md`](./PHASE_4_resolver.md) (Option B picked: SQLite FTS5 + WOF SQLite).

**Goal:** ship `@mailwoman/resolver-wof-sqlite` — a small standalone package that loads a Who's On First SQLite distribution and exposes a typed `PlaceLookup` interface backed by FTS5 full-text matching. Independently useful: callers can resolve `"Paris, FR"` → `wof_id: 101751119, lat: 48.85, lon: 2.34` without going through the full mailwoman parser.

**Branch:** `feature/phase-4-2-wof-sqlite` (this PR).

**Depends on:** `@mailwoman/core@2.x` Kysely boilerplate from #82.

## Why a separate package

Three independent reasons:

1. **Optional dependency.** Not every mailwoman user wants geocoding. `npm install mailwoman` should not pull in a SQLite loader they're not going to use. `@mailwoman/resolver-wof-sqlite` is opt-in.
2. **WOF data versioning is independent from parser versioning.** The SQLite distributions update on their own cadence at [data.geocode.earth/wof/dist/sqlite/](https://data.geocode.earth/wof/dist/sqlite/). Decoupling the package version from `@mailwoman/core` means we can ship a resolver patch without bumping core.
3. **License separation.** WOF data is **CC-BY 4.0** — attribution required in any redistribution. Keeping the loader package separate from the AGPL `@mailwoman/core` makes the attribution surface clean: anyone shipping the resolver inherits the obligation; anyone shipping just the parser does not.

## What's in scope for 4.2

- New workspace at `resolver-wof-sqlite/` (flat, no `packages/` nesting per the operator's monorepo convention).
- Typed Kysely `Database` schema for the WOF tables we'll touch: `spr`, `names`, `geojson`, `ancestors`, `place_search` (the FTS5 virtual table we build ourselves).
- `PlaceLookup` interface (the public surface).
- `WofSqlitePlaceLookup` implementation: FTS5 `MATCH` over name + name_alts, placetype + country filters, BM25 + boosts.
- A small fixture SQLite DB built inline in tests (no checked-in binary; tests `CREATE TABLE` + seed a handful of WOF-shaped rows).
- README documenting: which WOF distribution to use, how to point the loader at it, CC-BY attribution requirement.

## What's NOT in scope for 4.2

- Wiring into the parser pipeline — that's Phase 4.3.
- Decorating `AddressTree` with WOF ids / lat / lon / `src="wof-admin:..."` — that's Phase 4.3.
- CLI `--resolve` flag — that's Phase 4.3.
- Downloading the actual WOF distribution — that's an operator-side `mkdir` + `curl` (documented in the README; not automated by the package).
- Whether to publish a separate `wof-sqlite-data-*` weights-style package — defer; for v0.1 the operator points the loader at a path on disk.

## Architecture sketch

```
                 ┌─────────────────────────────────────────────────────┐
                 │  @mailwoman/resolver-wof-sqlite                     │
                 │                                                     │
                 │  ┌──────────────────────┐   ┌────────────────────┐  │
                 │  │ PlaceLookup          │←──│ WofSqlitePlaceLookup│  │
                 │  │ (interface)          │   │ (impl)             │  │
                 │  └──────────────────────┘   └─────────┬──────────┘  │
                 │                                       │             │
                 │                              ┌────────▼──────────┐  │
                 │                              │ Kysely<WofSchema> │  │
                 │                              │ → node:sqlite     │  │
                 │                              │   DatabaseSync    │  │
                 │                              └────────┬──────────┘  │
                 └───────────────────────────────────────┼─────────────┘
                                                         │
                                          ┌──────────────▼──────────────┐
                                          │  WOF SQLite distribution    │
                                          │  /path/to/whosonfirst-      │
                                          │  data-admin-us-latest.db    │
                                          │  (CC-BY 4.0 — attribute!)   │
                                          └─────────────────────────────┘
```

## Public API (this PR)

```ts
// resolver-wof-sqlite/index.ts

export interface PlaceCandidate {
	wof_id: number
	name: string
	placetype: WofPlacetype
	country: string // ISO 3166-1 alpha-2
	lat: number
	lon: number
	parent_id?: number
	score: number // BM25 + boosts; higher = better match
}

export type WofPlacetype =
	| "country"
	| "macroregion"
	| "region"
	| "macrocounty"
	| "county"
	| "localadmin"
	| "locality"
	| "borough"
	| "neighbourhood"
	| "microhood"
	| "postalcode"
	| "venue"
	| "campus"
	| "address"

export interface FindPlaceQuery {
	text: string
	placetype?: WofPlacetype | WofPlacetype[]
	country?: string // ISO 3166-1 alpha-2 — narrows the search
	parentId?: number // narrows to descendants of a specific WOF place
	limit?: number // default 10
}

export interface PlaceLookup {
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
	close(): void
}

export interface WofSqlitePlaceLookupOpts {
	databasePath: string
	/** Optional: pre-opened DatabaseSync (testing). Mutually exclusive with databasePath. */
	database?: DatabaseSync
}

export class WofSqlitePlaceLookup implements PlaceLookup, Disposable {
	constructor(opts: WofSqlitePlaceLookupOpts)
	findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]>
	close(): void
	[Symbol.dispose](): void
}
```

## WOF schema mapping

The Geocode Earth WOF SQLite distributions ship these tables that matter to us:

| Table          | Use                                                                                             | Notes                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spr`          | Standard Places Response — the core lookup table. One row per place with all the lookup fields. | PK `id`. Carries `parent_id`, `name`, `placetype`, `country`, `latitude`, `longitude`, `min_*`/`max_*` bbox, and lifecycle flags. `is_current = -1` means "currently valid" (WOF's -1/0 convention). |
| `names`        | Alternate names per place, keyed by BCP-47 language tag subfields.                              | Joins back to `spr.id` via `id` (NOT `place_id` — the column name is `id` on both tables, even though it's a FK on `names`). No `kind` column; FTS just concatenates ALL names.                      |
| `geojson`      | Per-place GeoJSON blob.                                                                         | Not consulted by Phase 4.2 — lat/lon already live as `spr.latitude` / `spr.longitude`. Modeled in `schema.ts` for Phase 4.3+ where bbox or full geometry may be needed.                              |
| `ancestors`    | Adjacency: ancestor relationships per place.                                                    | Used for `parentId` filter — descendant lookup is `WHERE spr.id IN (SELECT id FROM ancestors WHERE ancestor_id = ?)`.                                                                                |
| `place_search` | FTS5 virtual table. NOT in the upstream WOF distro — we build it.                               | `CREATE VIRTUAL TABLE place_search USING fts5(wof_id UNINDEXED, name, alt_names, ...)`. Built by `buildPlaceSearchFts()` lazily or by the `mailwoman-wof-build-fts` CLI ahead-of-time.               |

The Kysely `Database` interface declared in `resolver-wof-sqlite/schema.ts` types the columns we touch. Tables we don't touch (e.g. `concordances`, `spr` sibling tables) are not modeled — we don't want to pretend we understand schema we haven't read.

**Schema-discovery note (2026-05-20):** the initial Phase 4.2 ship assumed a `places` table with names joined on `place_id`. Real WOF has none of that — it uses `spr`, names join on `id`, and lat/lon are direct columns. Caught during the first run against real data; fixed in a same-day follow-up. The fixture tests were correctly green against the made-up schema; only the integration tests against actual WOF caught the mismatch. **Always validate against the real artifact** before declaring a data-integration done.

## Ranking

FTS5 BM25 default, with manual post-scoring:

- **Placetype boost.** When the query specifies `placetype: "locality"` and the candidate matches, +0.5 to score. When the query doesn't specify, locality gets +0.2 (most common case).
- **Country match boost.** When the query specifies `country`, candidates from that country get +0.3.
- **Parent match boost.** When the query specifies `parentId`, candidates that are direct children get +0.5, transitive descendants get +0.2.
- **Length penalty.** Candidates whose name is much longer than the query get a small penalty (`-0.1 * max(0, candidateLen - queryLen - 3) / 10`) — favors `Paris` over `Paris-l'Hôpital` when querying "paris".

Returned `score` is the post-boost number, **not** the raw BM25 — callers shouldn't depend on a specific scale, just relative ordering.

## Tests

Build a small fixture DB inline (~10 places: a couple of countries, a few regions, a handful of localities). No checked-in binary.

- `findPlace({text: "Paris"})` returns Paris,FR first.
- `findPlace({text: "Paris", country: "US"})` returns Paris,TX first.
- `findPlace({text: "London", placetype: "locality"})` filters out the borough of London,Ontario.
- `findPlace({text: "Springfield", parentId: <Illinois>})` returns Springfield,IL not Springfield,MA.
- Alternate-name match: `findPlace({text: "パリ"})` returns Paris,FR (via the `names` join).
- Disposable: `[Symbol.dispose]()` closes the DB.

Integration tests against a real WOF distribution will be added in a follow-up once the operator authorizes a download (the night-shift agent ran into an auto-mode block on the `data.geocode.earth` fetch).

## Open questions

- **Sync vs async driver.** `node:sqlite` is sync-only. For the resolver use case the entire `findPlace` is a single SQL query + post-scoring; sync is fine. If we ever need to query in a hot inference loop, revisit by moving the driver into a `Worker`.
- **FTS5 build cost.** Building the FTS5 index on first open is expensive against the planet-scale WOF distro (millions of rows). Mitigation in this PR: build is opt-in via `WofSqlitePlaceLookupOpts.buildFts: true` (default false). The README documents a one-shot CLI to build it ahead of time; the resolver assumes it exists.
- **Concurrency.** Kysely's `node:sqlite` driver (from `core/kysley/`) uses a single connection with a mutex. The resolver doesn't open multiple connections — one resolver instance = one DB connection = serialized queries. For multi-request servers, instantiate one resolver per request handler, not one shared.

## Changelog

- **2026-05-20** — opened. Picks the public API surface; defers the integration tests to follow-up once WOF data download is authorized.
- **2026-05-20** (same day) — WOF download authorized; schema-discovery fix needed (`places` → `spr`, `place_id` → `id`, no JSON-extract for lat/lon). 10 integration tests added against the real US admin shard. FTS5 build on the full shard (142k rows) completes in ~0.81s — much faster than the ~minutes estimate in the original plan. No popularity signal in the current ranking (documented limitation; bare `findPlace({text: "Paris"})` returns small-town US Parises in unspecified order); `country` / `placetype` / `parentId` filters all behave as designed.
