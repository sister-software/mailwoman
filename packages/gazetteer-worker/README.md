# @mailwoman/gazetteer-worker

This private workspace holds the Cloudflare Worker that answers gazetteer place lookups for the hosted geocoder. It
runs apart from the engine Worker, which holds the classifier, because the whole pipeline in one isolate exceeds
the 128 MB Worker memory limit. #2839 records the measurements.

The Worker's default export is a `WorkerEntrypoint`. A caller binds it as a service and calls its methods over RPC:

- `findPlace(query)` answers one query with the candidates of the browser resolver's `WOFCandidateTableLookup`,
  the lookup Earth's local mode runs. The query and the candidates have the shape `MailwomanLookupLike` declares in
  `@mailwoman/resolver-wof-wasm/browser-cascade`, so a caller passes the binding to `runCascade` as its lookup.
- `readStats()` reports the R2 reads the open database has made, or null before the first query.

Its `fetch` handler answers 404, and `wrangler.toml` disables the `workers.dev` route.

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
