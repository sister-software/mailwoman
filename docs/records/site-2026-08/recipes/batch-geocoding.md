---
title: Batch Geocoding
id: batch-geocoding
role: guide
audience: product-reader
source-of-truth: api/routes.ts, api/schema.ts, mailwoman/api-engine.ts
prerequisites: a running mailwoman serve instance with gazetteer data
verified-with: mailwoman v6.1.0
---

Suppose you have ten thousand addresses, from a spreadsheet, a CSV a colleague shared, or a nightly CRM export, and you want a coordinate for every row. Ten thousand individual requests would work, but most of the wall-clock time would go to HTTP overhead, and you would have to write the concurrency control yourself. The Mailwoman server has a bulk endpoint for this case. This recipe builds one `curl` command that turns a list of addresses into an ordered list of coordinates and handles the failure cases.

## The endpoint

`POST /v1/batch` takes a JSON body of `{ addresses: string[] }` and returns `{ results }` in the **same order you sent them**. See the [API reference](../api.mdx#drop-in-server-specifications-openapi-31) for the full OpenAPI interface. Run it against a `mailwoman serve` instance:

```bash
curl -s localhost:3000/v1/batch \
  -H 'content-type: application/json' \
  -d '{"addresses": ["350 5th Ave, New York, NY 10118", "Vienna, Austria"]}'
```

```json
{
	"results": [
		{
			"input": "350 5th Ave, New York, NY 10118",
			"lat": 40.747773,
			"lon": -73.985046,
			"resolution_tier": "interpolated",
			"uncertainty_m": 64,
			"locality": "New York",
			"region": "NY",
			"postcode": "10118",
			"house_number": "350",
			"street": "5th Ave",
			"countryCode": "US",
			"hierarchy": [
				{
					"tag": "locality",
					"value": "New York",
					"name": "New York",
					"lat": 40.694457,
					"lon": -73.93045,
					"placeID": "wof:85977539"
				},
				{
					"tag": "region",
					"value": "NY",
					"name": "New York",
					"lat": 42.921227,
					"lon": -75.596537,
					"placeID": "wof:85688543"
				}
			],
			"candidates": [
				{
					"name": "New York",
					"tag": "region",
					"lat": 42.921227,
					"lon": -75.596537,
					"countryCode": "US",
					"placeID": "wof:85688543"
				}
			]
		},
		{
			"input": "Vienna, Austria",
			"lat": 48.20849,
			"lon": 16.37208,
			"resolution_tier": "admin",
			"uncertainty_m": null,
			"locality": "Vienna",
			"region": null,
			"postcode": null,
			"house_number": null,
			"street": null,
			"countryCode": "AT",
			"hierarchy": [
				{
					"tag": "locality",
					"value": "Vienna",
					"name": "Vienna",
					"lat": 48.20849,
					"lon": 16.37208,
					"placeID": "wof:9000000038140"
				}
			],
			"candidates": [
				{
					"name": "Vienna",
					"tag": "locality",
					"lat": 48.20849,
					"lon": 16.37208,
					"countryCode": "AT",
					"placeID": "wof:9000000038140"
				},
				{
					"name": "Wien",
					"tag": "locality",
					"lat": 48.2083537,
					"lon": 16.3725042,
					"countryCode": "AT",
					"placeID": "wof:8000000584878"
				}
			]
		}
	]
}
```

The guaranteed order is what makes the bulk endpoint easy to use. You can match the `results` array back to your input rows by index without a join key. The second row's `hierarchy` and `candidates` include both "Vienna" and "Wien". The German endonym is a separate WOF place record for the same city, and the candidate list returns it as a runner-up.

## Rows fail independently

Most malformed input does not cause an error. An address without a recognizable component, such as an empty string, resolves normally with every field `null` and the tier at `admin`. A row throws only when it exceeds the classifier's token budget. The model tokenizes into a fixed 128-token window. A longer row, such as one where a CSV escaping bug concatenated an entire delivery note into the address column, throws inside the classifier instead of being truncated. Batch isolation handles that case. The server catches the error, puts it in that row's own `{ input, error }` slot, and still returns the rest of the batch.

```bash
# the second "address" is a 106-word, 600+ character delivery note that a CSV
# escaping bug dumped into the address column — shown truncated below (…)
curl -s localhost:3000/v1/batch \
  -H 'content-type: application/json' \
  -d '{"addresses": ["350 5th Ave, New York, NY 10118", "123 Main St, Springfield, IL 62701 -- customer requested delivery instructions: please leave the package behind the blue recycling bin near the side door rather than the front porch, because the front porch floods during rain …"]}'
```

```json
{
	"results": [
		{
			"input": "350 5th Ave, New York, NY 10118",
			"lat": 40.747773,
			"lon": -73.985046,
			"resolution_tier": "interpolated"
		},
		{
			"input": "123 Main St, Springfield, IL 62701 -- customer requested delivery instructions: please leave the package behind the blue recycling bin near the side door rather than the front porch, because the front porch floods during rain …",
			"error": "Cannot read properties of undefined (reading '0')"
		}
	]
}
```

Both the input and output above are truncated with `…` for the docs. The real 106-word string is about 400 characters longer, and the server returns it verbatim in the error slot.

Your code must therefore check each row for an error:

```ts
const res = await fetch("http://localhost:3000/v1/batch", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ addresses }),
})
const { results } = await res.json()

for (const [i, row] of results.entries()) {
	if ("error" in row) {
		console.warn(`row ${i} (${row.input}): ${row.error}`)
		continue
	}
	upsert(addresses[i], row.lat, row.lon, row.resolution_tier)
}
```

## One limit to size your chunks around

**Batch size** is capped at 1 000 addresses (`MAILWOMAN_BATCH_MAX`). A larger body returns a `413`, so split ten thousand addresses into ten requests. The cap is an environment variable, so you can change it on your server without recompiling.

Sorting does help. The first address in a US state loads that state's extract into the cache. A batch that keeps rows from the same state together resolves the later rows with almost no extra cost. If your data is already grouped by region, you get this benefit automatically.

Asking the server to process several rows at once does not help. The server geocodes a batch one row at a time, and it deliberately has no concurrency setting. A second row cannot progress while the first is in the model, because ONNX Runtime's Node binding holds the JavaScript thread for the whole inference, and the gazetteer reads are also synchronous. We shipped a `MAILWOMAN_BATCH_CONCURRENCY` worker pool and then measured it: throughput stayed at 1.00x from one worker to sixteen. It was removed on 2026-07-16.

To use more cores, you have to run work on other threads, which the streaming recipes below do. Even then, expect a modest gain. Geocoding is limited by memory and I/O on a shared multi-gigabyte database, and a measured sweep peaked at two workers. [The performance reference](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/performance.mdx) has the full measurements.

## Skipping the endpoint entirely

If the CSV is already on the machine that has the gazetteer, HTTP only adds overhead. Both recipes below use [spliterator](https://github.com/sister-software/spliterator) to stream the file, so a ten-million-row export uses the same memory as a ten-row one.

### Parsing only, with no gazetteer

When you want components rather than coordinates, for example to dedupe a mailing list or normalize a column before a join, skip the resolver. This recipe uses no database, so it needs no data root:

```ts
import { decodeAsTuples } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createRuntimePipeline } from "mailwoman"
import { createNewlineWriter, CSVSpliterator } from "spliterator"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier })

const rows = CSVSpliterator.fromAsync("addresses.csv", {
	mode: "object",
	normalizeKeys: true,
	enableQuoteHandling: true,
})

await using out = createNewlineWriter("parsed.jsonl")

for await (const row of rows) {
	const { tree } = await pipeline(String(row.full_address))
	const components = Object.fromEntries(decodeAsTuples(tree))
	await out.write(JSON.stringify({ id: row.id, ...components }))
}
```

```json
{ "id": "1", "house_number": "350", "street": "5th", "street_suffix": "Ave", "locality": "New York", "region": "NY", "postcode": "10118" }
{ "id": "2", "house_number": "1600", "street": "Pennsylvania Ave NW", "locality": "Washington", "region": "DC", "postcode": "20500" }
```

`enableQuoteHandling` keeps a quoted `"350 5th Ave, New York"` from splitting on its own comma. Without it, a street name can end up in the city column. `normalizeKeys` lowercases the header, so `Full Address` arrives as `full_address`.

This loop is single-threaded and processes about 300 addresses/second on one core. Worker threads should help here in principle, because there is no database to contend for, but nobody has measured it. Read the performance reference before you build that.

### Full geocoding, across worker threads

Coordinates need the gazetteer, and that per-row work takes milliseconds, which makes it worth moving to threads. [`geocodeStream`](https://github.com/sister-software/mailwoman/blob/main/mailwoman/geocode-stream.ts) wraps spliterator's `parallelMap`. It normalizes each row on the main thread and passes it to a worker, which builds its own classifier, resolver, and extracts.

```ts
import { dataRootPath } from "@mailwoman/core/utils"
import { normalizeCSV } from "@mailwoman/registry"
import { geocodeStream } from "mailwoman/geocode-stream"
import { createNewlineWriter } from "spliterator"

const mapping = { id: "id", address: "full_address" }

const geocoded = geocodeStream(normalizeCSV("addresses.csv", { mapping }), {
	mapping,
	geocode: {
		wofDBPath: dataRootPath("wof", "admin-global-priority.db").toString(),
		dataRoot: dataRootPath().toString(),
		locale: "en-US",
		country: "US",
	},
	concurrency: 2,
})

await using out = createNewlineWriter("geocoded.jsonl")

for await (const rec of geocoded) {
	await out.write(JSON.stringify({ id: rec.id, address: rec.address }))
}
```

Each record carries the same fields the endpoint returns, under `address.geocode`:

```json
{
	"id": "1",
	"address": {
		"components": {
			"house_number": "350",
			"street": "5th",
			"street_suffix": "Ave",
			"locality": "New York",
			"region": "NY",
			"postcode": "10118"
		},
		"canonicalKey": "350|5th|ave|new york|ny|10118",
		"formatted": "350 5th Ave, New York, NY 10118",
		"geocode": {
			"coordinate": { "latitude": 40.747773, "longitude": -73.985046 },
			"tier": "interpolated",
			"uncertaintyMeters": 42
		}
	}
}
```

Two details matter before you tune it. Records arrive in **completion order** rather than input order, so carry your own `id` through and rejoin downstream instead of relying on position. `concurrency: 2` is a deliberate value. The workers contend for one multi-gigabyte database, so throughput peaks at two workers and drops after that, and four workers perform no better than the baseline. Each worker also loads its own 38 MB model. Measure several concurrency values against your data instead of using `availableParallelism()`.
