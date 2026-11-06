# @mailwoman/gazetteer-worker

This private workspace holds the Cloudflare Worker that answers gazetteer place lookups for the hosted geocoder. It
runs apart from the engine Worker that holds the classifier, because the whole pipeline in one isolate exceeds
the 128 MB Worker memory limit. #2839 records the measurements.

The Worker's default export is a `WorkerEntrypoint`. A caller binds it as a service and calls its methods over RPC:

- `findPlace(query)` answers one query with the candidates of the browser resolver's `WOFCandidateTableLookup`,
  the lookup Earth's local mode runs. The query and the candidates have the shape `MailwomanLookupLike` declares in
  `@mailwoman/resolver-wof-wasm/browser-cascade`, so a caller passes the binding to `runCascade` as its lookup.
- `findLandmarks(name, source)` answers one bare place name from the Wikidata or OpenStreetMap landmark layer, best
  first, with at most 100 rows.
- `readStats()` reports the R2 reads the open database has made, or null before the first query.

Its `fetch` handler answers `GET /v1/landmarks?name=&source=` at `places.mailwoman.post`, with the same hits plus the
layer's credit and license, and answers 404 on every other path. `wrangler.toml` disables the `workers.dev` route.

## Where the layers live

`landmarks.db` holds Wikidata places under CC0 and stays in the `mailwoman-public` bucket. `places-osm.db` holds
OpenStreetMap places under the ODbL. It stays in the `mailwoman-tiles` bucket at `OSM_PLACES_DATABASE_KEY`, a key
outside the prefixes the tile Worker serves, so the route's bounded lookup is the one way to read it. A deployment of
your own builds that database with `packages/mailwoman/tools/dev-tools/landmarks/osm/places.run.ts` and accepts the
license's obligations.

## How it reads the database

`candidate.db` stays in the `mailwoman-public` R2 bucket, at the key `candidateDatabaseKey()` returns. SQLite runs as
the JSPI build of `@journeyapps/wa-sqlite`, with a read-only VFS whose page reads are R2 range reads of 64 KiB chunks.
The Worker keeps up to 256 chunks, 16 MiB, in a least-recently-used cache for the life of the isolate. The first
query opens the database, and queries run one at a time.

## Run the tests

The tests run in workerd through `@cloudflare/vitest-plugin`, against a local R2 bucket holding a small fixture
database that `vitest.config.ts` builds. The root Vitest sweep excludes this workspace.

```sh
yarn workspace @mailwoman/gazetteer-worker test
```
