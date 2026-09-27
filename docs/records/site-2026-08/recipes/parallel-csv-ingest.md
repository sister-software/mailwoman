---
title: Ingesting Giant CSVs
id: parallel-csv-ingest
role: guide
audience: product-reader
source-of-truth: registry/ingest.ts, mailwoman/geocode-stream.ts, mailwoman/geocode-worker.ts
prerequisites: "@mailwoman/registry; a CSV too big for memory; gazetteer data for the optional geocode stage"
verified-with: mailwoman v6.1.0
---

National datasets often arrive as a single CSV, such as the NPPES provider registry (millions of rows), an FCC broadband availability release, or a state address export. You need every row normalized into the same shape, and ideally a coordinate for each one. Two problems stand in the way: the file does not fit in memory, and geocoding a million addresses sequentially takes hours. This recipe handles both with a simple streaming normalize stage and an optional threaded geocode stage that you add only when the per-row cost justifies it.

## Start with a stream rather than a file

`normalizeCSV` (from `@mailwoman/registry`) takes a path and a column mapping and returns an async iterable of `SourceRecord`s. It reads the header and then yields one normalized record per row. It never holds more than a row or two in memory, so the file size does not matter.

```ts
import { normalizeCSV } from "@mailwoman/registry"

const mapping = {
	id: "NPI",
	name: "Provider Name",
	organization: "Provider Organization Name",
	address: ["Address Line 1", "City", "State", "Postcode"],
}

for await (const record of normalizeCSV("nppes.csv", { mapping })) {
	// record.id, record.name, record.organization, record.raw …
	sink.write(record)
}
```

The `mapping` is the entire configuration. Each field lists the column, or columns, that it reads from. A field with several columns, like `address` above, joins them in order, so four NPPES columns become `"500 N Hiatus Rd Ste 200, Pembroke Pines, FL, 33026"`. The original row is kept verbatim on `record.raw`, so no data is lost. Downstream stages recompute from the raw row instead of relying on a lossy projection.

`normalizeCSV` does not produce a coordinate, and `record.address` is deliberately undefined here. Normalizing a row (mapping columns, parsing the name, canonicalizing the org) takes microseconds, so it runs cheaply on a single thread. Geocoding has very different costs.

## Why geocoding is a separate stage

With a million rows, it is tempting to spread the work across all cores. That helps for expensive work and hurts for cheap work, and the boundary between the two is sharper than it looks.

Dispatching a row to a worker thread and getting the result back has a fixed cost: serializing the row, deserializing the result, and a few microseconds of structured clone in each direction. Normalizing a row costs about the same. Threading the normalize step therefore spends a microsecond to save a microsecond. Spread across eight cores, it gets _slower_, because the main thread spends all its time packing and unpacking messages. We measured this on light CSV work at 0.3–0.9× of single-threaded speed. Keep the cheap stage on one thread.

Geocoding is the opposite case. Each address runs a neural parse and several lookups against a multi-gigabyte gazetteer, which takes milliseconds, about a thousand times the dispatch cost. At that scale the fixed overhead is negligible, and threads help. The division follows from these costs: **normalize on the main thread, geocode in workers.**

## Compose them, and filter in between

`geocodeStream` (from `mailwoman/geocode-stream`) is the threaded stage. It takes the record stream and a geocoder config, runs the addresses across a worker pool, and yields the records with `address` populated. It consumes and produces an async iterable, so it composes directly with `normalizeCSV`. The main thread sits between the two stages, which is where your filter belongs:

```ts
import { normalizeCSV } from "@mailwoman/registry"
import { geocodeStream } from "mailwoman/geocode-stream"

const geocode = {
	wofDBPath: "/data/wof/admin-global-priority.db",
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

The filter is where the savings come from. Geocoding is the expensive stage, so every row you discard _before_ it saves a worker dispatch. If you normalize a million rows and keep the 300 K with a usable address, only those rows reach the pool. Filtering takes a microsecond and geocoding takes milliseconds, so reject rows before geocoding.

## How the workers stay cheap

A worker cannot receive your geocoder, because a 4 GB SQLite handle and a loaded neural model cannot be passed through `postMessage`. `geocodeStream` sends each worker only the serializable `geocode` config (paths, locale). Each worker _builds_ its own classifier, WOF lookup, resolver, and extract provider at startup. After startup, the main thread sends each worker only records and receives only the enriched records back.

This design has two consequences:

- **Each worker opens the DB read-only.** Each worker has its own handle to the same gazetteer file. The OS page cache is shared, so the data is not copied N times, but N readers do contend for it, as the next section shows.
- **Records arrive in completion order rather than input order.** The pool finishes rows as workers become free, so do not match the output to your input by position. Re-key by `record.id`, which is why the mapping always includes one.

## Don't reach for all your cores

For this reason, `geocodeStream` sets a low default `concurrency` instead of your core count. Geocoding looks CPU-bound, but it is limited by latency and memory. Every row makes random reads into the multi-gigabyte WOF database, and the classifier already spreads each inference across several cores. Additional workers get no additional compute. They contend for the same memory bandwidth and the same DB pages.

A sweep over real NPPES addresses on a 16-core machine with a single 4 GB gazetteer produced these results:

| Workers |    Throughput |  Speedup |
| ------: | ------------: | -------: |
|       1 |     43 rows/s |       1× |
|   **2** | **57 rows/s** | **1.4×** |
|       3 |     51 rows/s |     1.2× |
|       4 |     47 rows/s |     1.1× |
|       6 |     43 rows/s |       1× |

Throughput peaks at two workers and _declines_ after that. At six workers it is back to the single-threaded rate while using six cores. Capping per-worker inference threads did not change the result, because the limit is the shared database rather than the CPU. Measure several `concurrency` values for your data and disk, starting low. Threading the geocode stage gives a real but modest gain (~1.4×), and adding more workers loses it.

If your gazetteer fits in RAM or is spread across several disks, your throughput curve will be higher, so measure it. The default (`min(4, cores)`) is deliberately conservative, so that the default behavior improves throughput instead of overloading the database.

## When to stop at `normalize`

Not every ingest needs a coordinate. If you load records to dedupe by name and org, or to join on an ID, the address is never geocoded. Without an expensive stage to thread, `normalizeCSV` does the whole job. Adding `geocodeStream` there would only add worker overhead to microsecond work, the loss described two sections earlier. Thread only the stage whose per-row cost justifies it.

Once you have geocoded `SourceRecord`s, [Geocode-first record matching](../concepts/geocode-first-record-matching.mdx) covers the dedup and entity-resolution step that this ingest usually feeds, and [Displaying results on a map](./display-on-a-map.md) covers plotting the output on a map.
