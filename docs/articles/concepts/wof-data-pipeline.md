---
sidebar_position: 20
title: WOF data pipeline — sync, prepare, resolve
---

# WOF data pipeline — sync, prepare, resolve

Who's On First (WOF) is the gazetteer underneath Mailwoman's Stage 6 resolver. It provides place IDs, parent-child chains, placetypes, and multilingual name variants for every admin boundary on Earth. This article documents how the Mailwoman codebase ingests, normalises, and serves that data — including what's complete, what's stalled, and where the reconciler integration will eventually plug in.

If you've read [Resolver and Who's On First](./resolver-and-wof.md) for the runtime story, this is the build-time companion: how the data gets from raw GeoJSON on GitHub to a queryable per-placetype SQLite DB.

## The end-to-end flow (as designed)

```
WOF GitHub repos                     Per-placetype SQLite DBs
(100K+ .geojson files)               (<placetype>/<lang>.db)
         │                                     ▲
         │ git clone / pull                    │ upsert
         ▼                                     │
┌─────────────────┐     ┌──────────────────┐   │
│ commands/wof/   │     │ commands/wof/    │   │
│   sync.tsx      │────▶│   prepare/       │───┘
│                 │     │   index.tsx       │
│ • gh repo list  │     │   _app_worker    │
│ • git clone     │     │                  │
│ • Placetype     │     │ • glob *.geojson │
│   .prepare()    │     │ • Piscina batch  │
└─────────────────┘     │ • pluckSpec      │
                        │ • write to DB    │ ← stalled here
                        └──────────────────┘
```

**Status:**

- **sync** works end-to-end. Clones WOF repos, filters via `--repos`, calls `Placetype.prepare()` to load the hierarchy.
- **prepare** has the globbing + Piscina parallelism + GeoJSON parsing working, but writes to the **wrong target** (Redis) instead of `PlacetypeDataSource` (SQLite). The pipeline stalls at the storage boundary.
- **PlacetypeDataSource** schema is correct and has working `upsert` + `find` methods, but nobody calls `upsert` in the production data path.

## Layer by layer

### `commands/wof/sync.tsx` — repo cloning

Discovers WOF data repos via `gh repo list whosonfirst-data --no-archived`, optionally filtered by `--repos` (comma-separated allow-list). Clones or pulls each into a local directory. After all repos sync, calls `Placetype.prepare()` to load the placetype hierarchy from `whosonfirst-placetypes`.

The `--repos` filter exists because the corpus build only needs a handful of repos (admin-us, admin-fr, postalcode-us, postalcode-fr) and cloning all ~100 WOF repos is 2.9 GB of git for no benefit.

### `commands/wof/prepare/index.tsx` — batch GeoJSON processing

The heavy-lift command. Designed to process 100K+ individual `.geojson` files (one per WOF feature) using Piscina worker threads.

**Architecture:**

- Main thread globs `**/*.geojson` from the admin directory via `fast-glob` streaming.
- Files are batched via `takeAsync(matchStream, BATCH_SIZE)` — yields arrays of filenames, one per available CPU core.
- Each batch is dispatched to workers via `takeInParallel(fileNames, BATCH_SIZE, delegateInsertion)`.
- Workers run `_app_worker.mts::insertRecord(filePath)`: reads the file, parses GeoJSON, calls `pluckPlacetypeSpec` to extract structured fields.

**What `pluckPlacetypeSpec` produces:**

```ts
interface ParsedWOFPlacetype {
	id: number
	parent_id: number
	name: string
	src: string
	placetype: WhosOnFirstPlacetype
	localizedPropMap: Map<Alpha3bLanguageCode, Map<WOFNameKind, string>>
}
```

The `localizedPropMap` is the multilingual name-variant surface — for each language code (ISO 639-3b), it carries `preferred`, `variant`, `colloquial`, `abbr`, and `short` forms. This is exactly what `PlacetypeDataSource.records` expects in its columns.

**Where it stalls:** the worker currently targets Redis (`ioredis` sadd per placetype/language/name-kind) — an earlier iteration where the pipeline was backed by a Redis instance. The rest of the codebase has since moved to SQLite via `PlacetypeDataSource`. The worker needs to write to SQLite instead.

### The incomplete "send batches of filenames" design

The original intent was more efficient than the current per-file dispatch:

1. Main thread globs a batch of N filenames (N = `availableParallelism()`).
2. Sends the entire batch to ONE worker (not one filename per Piscina task dispatch).
3. Worker processes the batch sequentially (file reads are fast once in cache), builds up an in-memory table of results.
4. Worker returns the batch results to the main thread (or writes directly to an in-memory SQLite, then flushes).

This design reduces IPC round-trips (one per batch vs one per file) and lets the worker keep a warm DB connection open across the batch instead of opening/closing per row. The per-file dispatch shape currently in the code was the first iteration; the batched-filename shape was the intended next step.

### The in-memory-SQLite-then-consolidate idea

A related design that never took shape: each Piscina worker holds its own `:memory:` SQLite database during the batch, inserts all processed records into it (zero disk I/O during the hot path), then at batch-end dumps the in-memory DB to a temporary file and signals the main thread. The main thread then merges N temporary DB files into the final per-placetype/per-language DBs on disk via `ATTACH DATABASE` + `INSERT INTO ... SELECT FROM ...`.

Why in-memory first:

- Avoids disk thrashing during the hot path (100K individual writes to the same few DB files from N concurrent workers would serialize on SQLite's WAL writer).
- Workers are completely independent — no shared file handles, no lock contention during processing.
- Consolidation is a single bulk operation after all workers finish, which SQLite handles efficiently via `ATTACH`.

This never went past the design stage. The Redis target worked well enough for prototyping, and by the time it was clear Redis wouldn't survive into production, other priorities (the neural classifier, corpus pipeline, resolver integration) took precedence.

### `PlacetypeDataSource` — the target schema

Per-placetype, per-language SQLite DB files at `<dataDir>/<placetype>/<lang>.db`. Schema:

```sql
CREATE TABLE records (
  'id'        INTEGER NOT NULL,
  'src'       TEXT NOT NULL,
  'name'      TEXT NOT NULL,
  'preferred' TEXT,
  'variant'   TEXT,
  'colloquial' TEXT,
  'abbr'      TEXT,
  'short'     TEXT,
  'parent_id' INTEGER,
  PRIMARY KEY ('id', 'src', 'name')
);
```

- `id`: WOF Brooklyn Integers ID.
- `parent_id`: the hierarchy chain for concordance scoring.
- `name` + variant columns: the alias-resolution surface the reconciler needs ("Saint Petersburg" vs "St. Petersburg" vs "St Petersburg" are `name`, `variant`, and `short` for the same ID).
- `src`: provenance tracking (whosonfirst, quattroshapes, etc.).

`DataSourceCache` manages a pool of open `PlacetypeDataSource` handles, keyed by `(placetype, languageCode)`. Lazy-opens on first access; disposable.

### `Placetype` — the hierarchy cache

In-memory hierarchy built from the `whosonfirst-placetypes` codex (a JSON spec defining the parent/child/sibling graph of all WOF placetypes). `Placetype.prepare()` reads the JSON files from the cloned repo and populates static maps (`#byID`, `#byName`, `#childrenOfParentName`).

This is NOT the per-record parent_id chain — it's the **placetype-level** hierarchy (country → region → county → locality → neighbourhood). The per-record `parent_id` chain lives in `PlacetypeDataSource`.

### `WOFPlacenameCache` + `loader.ts` — the GeoJSON-direct index

A separate path that builds a normalised placename→languages index directly from the GeoJSON source files via `fast-glob` + `TextSpliterator`. Used by the rule-based classifiers (locality/region dictionaries) to answer "is this string a known placename in any language?" without going through SQLite.

This is the path that works today. It reads raw GeoJSON and builds Map-based indexes in memory. It doesn't use `PlacetypeDataSource`. The two paths (`WOFPlacenameCache` for rule classifiers, `PlacetypeDataSource` for the resolver/reconciler) were always intended to coexist — different query patterns, different storage trade-offs.

## Where Spliterator fits

The `spliterator` package (published separately at `@sister-software/spliterator`) was born from this pipeline's needs:

- **`TextSpliterator`** — line-delimited iteration over file streams without loading entire files into memory. Used by `loader.ts` for reading the large WOF GeoJSON bundles.
- **`AsyncSpliterator.asMany(source, delimiter, concurrency)`** — splits a single large file into N concurrent byte-range iterators for parallel processing. Designed for the case where WOF data arrives as a single NDJSON dump (e.g. from data.geocode.earth) rather than 100K individual files. Marked `@internal`; never exercised at scale because the individual-file path was sufficient for the repos we actually use.
- **`asyncParallelIterator` / `takeAsync`** — the batching primitives that `commands/wof/prepare` uses to dispatch work to Piscina workers. `takeInParallel` in `core/resources/collections.ts` is the local equivalent (bounded-concurrency async generator).

The relationship: Spliterator handles the **read** parallelism (splitting a file into chunks); Piscina handles the **compute** parallelism (processing parsed records across CPU cores); `PlacetypeDataSource` handles the **write** (structured storage). The pipeline needs all three layers; today only the first two are wired.

## How this connects to the reconciler

The Stage 5 joint decoder (`reconcileSpans` in `core/pipeline/reconcile.ts`) needs three inputs per span:

1. **Phrase proposals** — from the phrase grouper (shipped, working).
2. **Classifier top-k** — from per-span logit aggregation (being wired now, PR in progress).
3. **Resolver candidates + parent chains** — from `PlacetypeDataSource`.

Item 3 is what this pipeline produces. Specifically:

- **Name lookup**: given a span body like "Houston", find all `PlacetypeRecord` rows where `name = 'Houston'` OR `variant = 'Houston'` OR `abbr = 'Houston'` etc. Filter by `placetype` (e.g. only `locality` candidates for a span the classifier tagged as locality).
- **Disambiguation**: when multiple candidates exist (there are 13 "Houston" entries in WOF US admin), filter by `parent_id` — the classifier's region tag for the same input narrows the candidate set.
- **Parent-chain walk**: for concordance scoring, walk `parent_id` up the hierarchy until reaching `country`. The chain `Houston (id=3) → Texas (id=2) → United States (id=0)` is what tells the reconciler that `locality=Houston, region=TX` is coherent.

The WOF spot-check (2026-05-24) confirmed the raw `spr` table's parent_id chains are trustworthy (18/20 correct) but surfaced two findings the prepare pipeline needs to address:

1. **Name aliasing**: "Saint Petersburg" not found via bare `name` lookup — WOF stores it as "St. Petersburg". The `variant`/`short` columns in `PlacetypeDataSource` are designed for exactly this; they just need to be populated.
2. **Disambiguation**: bare-name lookup without `parent_id` filtering picks the wrong record (a Nebraska village named "New York" outranks NYC by alphabetical ID ordering). The `find` query needs a `parent_id` filter or population-weighted ranking.

Both findings are closed by completing the prepare pipeline (populates the variant columns) and using `PlacetypeDataSource.find` with appropriate criteria (filters by parent_id or placetype).

## What needs to happen next

In priority order:

1. **Migrate the worker target from Redis to SQLite.** Recommended shape: worker opens `PlacetypeDataSource` per (placetype, language) on demand, batch-inserts via a wrapped transaction (1000 rows per COMMIT for throughput). Workers operate on separate DB files so no cross-process locking.

2. **Batch filenames to workers** instead of dispatching one-at-a-time. Reduces IPC overhead. Each Piscina task gets an array of file paths; worker processes them sequentially with a warm DB connection.

3. **Wire `PlacetypeDataSource` into the reconciler** as the `ResolverCandidatesLookup` + `ParentChainLookup` implementation. This replaces the mocked resolver in the reconciler's current test surface with real data.

4. **(Stretch) In-memory-then-consolidate pattern** for maximum throughput. Workers write to `:memory:` during the hot path, dump to temp files at batch-end, main thread merges via `ATTACH`. Only worth pursuing if step 1+2 are too slow for the full WOF dataset (~120K features × 5-10 languages = 600K-1.2M rows).

## See also

- [Resolver and Who's On First](./resolver-and-wof.md) — the runtime resolver that consumes this data
- [The knowledge ladder](../../articles/understanding/our-approach/the-knowledge-ladder.md) — Stage 6 in the pipeline decomposition
- [Joint decoding — a walkthrough](./joint-decoding-walkthrough.md) — how the reconciler uses resolver candidates + parent chains
- [`STAGES.md`](../plan/reference/STAGES.md) — formal per-stage type contracts
