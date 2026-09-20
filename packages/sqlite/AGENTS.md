# AGENTS.md — `@mailwoman/sqlite`

Scope notes for database construction and inline SQL across the repository. The repo-wide rules live
in the root `AGENTS.md`; this file covers how a database artifact is built and which SQL stays raw,
and it exists because each decision below cost a real investigation to establish.

If you are building a database, remember that they are readonly artifacts which should not be modified after creation. If the script builds a database, take care to build it successfully, then move the previous version to a temp directory, and then move the new version into place. This ensures that the database is always in a consistent state, even if the build script fails halfway through.

When making a database, use Kysley as the database connector. It is a thin wrapper around SQLite that provides a simple interface for creating and querying databases and is backed by the native `node:sqlite` module. It is the only supported database connector for this repo.
Table DDL goes through Kysely's schema-builder rather than raw `db.exec("CREATE TABLE …")`. The idiom, established across #745–#749:

- A schema module owns both the typed `Database` interface and a co-located `createXTable(db)` function built with `db.schema.createTable(...)`. The interface is the read/write interface; the builder creates the table; a column added to one is a compile error against the other. See `packages/resolver-wof-sqlite/{candidate,address-point,postal-city-candidate,postal-city-alias}-schema.ts`, `packages/resolver-wof-sqlite/lib/unified-schema.ts`, and `packages/tiger/lib/sdk/schema.ts`.
- `DatabaseClient` (`@mailwoman/core/kysley/client`) extends `Kysely` over `node:sqlite`. A build script constructs the raw `DatabaseSync` for its **hot positional INSERTs** (the bulk-load fast path) and wraps that _same_ handle in a `DatabaseClient` for the DDL — one connection, shared; `kdb.destroy()` owns the close. The schema-builder is async, so the DDL functions and their callers are `async`.
- `WITHOUT ROWID` has no first-class builder — use the ``.modifyEnd(sql`without rowid`)`` raw modifier. It's a win only for small-row, PK-probed tables (the candidate gazetteer, `pl_block`); never for a table carrying a large blob like geometry, where clustering the row into the B-tree _hurts_.

## What deliberately stays raw — don't "finish the job" on these

Some inline SQL is raw on purpose. If you migrate one of these thinking it was missed, you'll regress it. Each has a reason:

- **FTS5 virtual tables + `MATCH`** (`fts.ts`, `lookup.ts`, `extracts.ts`) — Kysely can't express `CREATE VIRTUAL TABLE … USING fts5` or the `MATCH` operator.
- **ogr2ogr / GDAL-dialect SQL** (`packages/tiger/lib/sdk/fetch.ts`) — runs inside ogr2ogr against shapefiles rather than the app DB.
- **Hot bulk writes** — the positional prepared-statement INSERT loops, their `BEGIN`/`COMMIT`, and the candidate clustering `INSERT … SELECT … ORDER BY`. Plus `PRAGMA`, `VACUUM`, `ANALYZE`, `ATTACH` — none are Kysely-modelled, and the inserts are the throughput path.
- **Runtime-dynamic schemas** (`packages/corpus/scripts/ingest-csv.ts`) — columns + types are inferred from the CSV at runtime; a builder loop wraps the same dynamic strings with ceremony and no added type safety.
- **Introspect-and-replay** (`packages/resolver-wof-sqlite/lib/build/slim.ts`) — it execs the _source_ DB's own `CREATE TABLE` strings read from `sqlite_master`; a static builder can't express a copied schema.
- **Async-into-sync walls** — `PlacetypeDataSource.ts` runs its DDL in a synchronous class constructor; `zcta-centroids.ts` and `coincident-roles.ts` are sync, heavily-tested helpers (the latter behind a sync CLI). Kysely's builder is async, so migrating cascades `async` through a sync call graph and rewrites the tests, all for one small table — not worth it.
- **Sync-by-interface resolver readers** — the resolution ladder is synchronous by design: `AddressPointLookup.find()`, `InterpolationLookup.find()`, `PostcodeResolver.lookup()`, and `ConventionSource.get()` (`packages/core/lib/resolver/types.ts`) return values synchronously, and `PostcodeResolver` is called from `@mailwoman/neural`. So the readers implementing them — `address-point.ts`, `interpolation.ts`, `postcode-point-lookup.ts`, `sqlite-convention-source.ts`, `ancestry.ts`, and the hot per-keystroke `candidate-lookup` probe — stay on raw `.prepare()`. Converting one to async Kysely doesn't cascade a few call sites; it forces the shared interface async, rippling through every implementer and across the package boundary — a structural architecture change rather than a query swap. (#752's `postal-city-alias` reader was the one exception: not interface-bound, and its sole caller was already inside the async `findPlace`.)

On the query side, the migratable remainder is the cold, already-`async` `SELECT`/`INSERT` sites in the build / eval / corpus scripts — typing there is a free win with no hot-path or interface concern. The DuckDB builders need no `@oorabona/kysely-duckdb` dialect: their SQL is `read_parquet`/`ST_Read` (raw); only the SQLite output tables migrate, and those reuse the shared schema builders (see `build-postal-city-alias.ts`).
