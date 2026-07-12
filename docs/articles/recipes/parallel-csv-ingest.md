---
title: Ingesting Giant CSVs
id: parallel-csv-ingest
---

Someone hands you a national dataset as a single CSV — the NPPES provider registry (millions of rows), an FCC broadband availability drop, a state address export. You need every row normalized into the same shape, and ideally a coordinate on each one. Two things stand in the way: the file won't fit in memory, and geocoding a million addresses one after another takes hours. This recipe is the shape that handles both — a streaming normalize core you can hold in your head, plus an optional threaded geocode stage you bolt on only when the per-row cost earns it.

## Start with a stream, not a file

`normalizeCSV` (from `@mailwoman/registry`) takes a path and a column mapping and hands back an async iterable of `SourceRecord`s. It reads the header, then yields one normalized record per row — it never holds more than a row or two in memory, so the file size doesn't matter.

```ts
import { normalizeCSV } from "@mailwoman/registry"

const mapping = {
	id: "NPI",
	name: "Provider Name",
	organization: "Provider Organization Name",
	address: ["Address Line 1", "City", "State", "Postal Code"],
}

for await (const record of normalizeCSV("nppes.csv", { mapping })) {
	// record.id, record.name, record.organization, record.raw …
	sink.write(record)
}
```

The `mapping` is the whole interface: each field names the column (or columns) it draws from. A field with several columns — like `address` above — gets them joined in order, so four NPPES columns become `"500 N Hiatus Rd Ste 200, Pembroke Pines, FL, 33026"`. The original row survives verbatim on `record.raw`, so nothing is lost; downstream stages recompute from it rather than trusting a lossy projection.

What you _don't_ get from `normalizeCSV` is a coordinate. `record.address` is undefined here, on purpose — normalizing (column-map, parse the name, canonicalize the org) costs microseconds a row, and that's the cheap, single-threaded core. Geocoding is a different animal.

## Why geocoding is a separate stage

The instinct with a million rows is "throw it on all my cores." That instinct is right for expensive work and actively wrong for cheap work, and the line between them is sharper than it looks.

Dispatching a row to a worker thread and getting the result back costs something fixed — serialize the row out, deserialize the result in, a few microseconds of structured-clone either way. Normalizing a row costs about the same. So threading the normalize step spends a microsecond to save a microsecond: you'd run it across eight cores and watch it get _slower_, because the main thread now spends all its time packing and unpacking messages. We measured exactly this on light CSV work — 0.3–0.9× of single-threaded. Don't thread the cheap stage.

Geocoding is the opposite. Each address runs a neural parse and several lookups against a multi-gigabyte gazetteer — milliseconds, not microseconds, a thousand times the dispatch cost. There the fixed overhead vanishes into the work, and threads pay off. So the split writes itself: **normalize on the main thread, geocode in workers.**

## Compose them, and filter in between

`geocodeStream` (from `mailwoman/geocode-stream`) is the threaded half. It takes the record stream and a geocoder config, runs the addresses across a worker pool, and yields the records back with `address` populated. Because it consumes an async iterable and produces one, it composes directly onto `normalizeCSV` — and the main thread sits between them, which is exactly where you want your filter:

```ts
import { normalizeCSV } from "@mailwoman/registry"
import { geocodeStream } from "mailwoman/geocode-stream"

const geocode = {
	wofDbPath: "/data/wof/admin-global-priority.db",
	dataRoot: "/data",
	locale: "en-US",
	country: "US",
}

const normalized = normalizeCSV("nppes.csv", { mapping })

// Cheap, on the main thread: drop rows you'll never geocode before paying for a worker.
async function* onlyWithAddress(records) {
	for await (const r of records) if (r.raw?.["Address Line 1"]) yield r
}

for await (const record of geocodeStream(onlyWithAddress(normalized), { mapping, geocode })) {
	sink.write(record) // record.address is now populated
}
```

That filter is the quiet win. Geocoding is the expensive stage, so every row you discard _before_ it is a worker dispatch you never pay for. Normalize a million rows, keep the 300 K with a usable address, and only those reach the pool. Filtering is a microsecond; geocoding is milliseconds — do the cheap rejection first.

## How the workers stay cheap

A worker can't receive your geocoder — a 4 GB SQLite handle and a loaded neural model don't survive a `postMessage`. So they don't cross. `geocodeStream` sends each worker only the serializable `geocode` config (paths, locale), and the worker _rebuilds_ its own classifier, WOF lookup, resolver, and shard provider at startup. After that, only the config went out and only the enriched record comes back.

Two consequences worth holding onto:

- **The DB is opened per worker, read-only.** Each worker opens its own handle to the same gazetteer file; the OS page cache is shared underneath, so you're not paying for N copies of the data, but you _are_ paying for N readers contending on it (more on that next).
- **Records arrive in completion order, not input order.** A pool finishes rows as workers free up, so don't zip the output back onto your input by position. Re-key by `record.id` — which is why the mapping always carries one.

## Don't reach for all your cores

This is why `geocodeStream` defaults its `concurrency` low instead of to your core count, and it surprises people: geocoding looks CPU-bound, but it is latency- and memory-bound. Every row makes random reads into that multi-gigabyte WOF database, and the classifier already spreads each inference across several cores. Stack more workers on top and they don't get more compute; they contend for the same memory bandwidth and the same DB pages.

A sweep over real NPPES addresses on a 16-core box, single 4 GB gazetteer:

| Workers |    Throughput |  Speedup |
| ------: | ------------: | -------: |
|       1 |     43 rows/s |       1× |
|   **2** | **57 rows/s** | **1.4×** |
|       3 |     51 rows/s |     1.2× |
|       4 |     47 rows/s |     1.1× |
|       6 |     43 rows/s |       1× |

Throughput peaks at two workers and _declines_ from there — by six, you're back to single-threaded, having spent six cores to get there. Capping per-worker inference threads didn't move it either; the ceiling is the shared database, not the CPU. So treat `concurrency` as something you sweep for your data and your disk, starting low. The win from threading geocode is real but modest (~1.4×), and the way to lose it is to ask for more.

If your gazetteer fits in RAM, or you've sharded it across disks, your curve will sit higher — measure it. The default (`min(4, cores)`) is deliberately conservative so the out-of-the-box behavior helps rather than thrashes.

## When to stop at `normalize`

Not every ingest needs a coordinate. If you're loading records to dedupe by name and org, or to join on an ID, the address never gets geocoded — so there's no heavy stage to thread, and `normalizeCSV` on its own is the whole job. Reaching for `geocodeStream` there would only add worker overhead to microsecond work, the exact loss from two sections ago. Thread the stage that earns it; leave the cheap one alone.
