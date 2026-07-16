---
title: Batch Geocoding
id: batch-geocoding
role: guide
audience: product-reader
source-of-truth: api/routes.ts, api/schema.ts, mailwoman/api-engine.ts
prerequisites: a running mailwoman serve instance with gazetteer data
verified-with: mailwoman v6.1.0
---

You have a spreadsheet — ten thousand addresses, a CSV a colleague dropped in Slack, a nightly export from your CRM — and you want a coordinate for every row. Firing ten thousand individual requests works, but you'll spend most of the wall-clock time on HTTP overhead and you'll have to write the concurrency control yourself. The Mailwoman server has a bulk endpoint for exactly this. By the time you're done here you'll have one `curl` command that turns a list of addresses into a list of coordinates, in order, with the failure cases handled.

## The endpoint

`POST /v1/batch` takes a JSON body of `{ addresses: string[] }` and returns `{ results }` in the **same order you sent them** — see the [API reference](../api.mdx#drop-in-server-specifications-openapi-31) for the full OpenAPI contract. Run against a `mailwoman serve` instance:

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

Order is the contract that makes the bulk path usable: zip the `results` array straight back onto your input rows by index, no join key required. The second row's `hierarchy`/`candidates` carry both "Vienna" and "Wien": the German endonym is a distinct WOF place record for the same city, and the candidate list surfaces it as a runner-up.

## Rows fail independently

Most malformed input doesn't error at all: an address with no recognizable component (an empty string, say) resolves fine, every field lands `null`, and the tier settles at `admin`. What throws is a row that overruns the classifier's token budget. The model tokenizes to a fixed 128-token window, and a row that blows past it — a CSV escaping bug that concatenated an entire delivery note into the address column, for instance — throws deep inside the classifier instead of truncating gracefully. Batch isolation exists for exactly that case: a row that throws is caught and parked in its own `{ input, error }` slot, and the rest of the batch still comes back.

```bash
# the second "address" is a 106-word, 600+ character delivery note that a CSV
# escaping bug dumped into the address column — shown truncated below (…)
curl -s localhost:3000/v1/batch \
  -H 'content-type: application/json' \
  -d '{"addresses": ["350 5th Ave, New York, NY 10118", "123 Main St, Springfield, IL 62701 -- customer requested delivery instructions: please leave the package behind the blue recycling bin near the side door, not the front porch, because the front porch floods during rain …"]}'
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
			"input": "123 Main St, Springfield, IL 62701 -- customer requested delivery instructions: please leave the package behind the blue recycling bin near the side door, not the front porch, because the front porch floods during rain …",
			"error": "Cannot read properties of undefined (reading '0')"
		}
	]
}
```

(Both the input and output above are truncated with `…` for the docs. The real 106-word string runs another 400-odd characters, and the server echoes it back verbatim in the error slot.)

So the one check you can't skip is per-row:

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

**Batch size** caps at 1 000 addresses (`MAILWOMAN_BATCH_MAX`); send more in one body and you get a `413`. Chunk your ten thousand into ten requests. It's an environment override, so you set it for your box rather than recompiling.

Sorting helps, though: the first address in a given US state warms that state's shard cache, so a batch that keeps same-state rows together resolves the tail of them almost for free. If your data is already grouped by region, you're getting that win without doing anything.

What won't help is asking the server to work on several rows at once. A batch is geocoded one row at a time, and we left that knob out on purpose. A second row can't make progress while the first is in the model, because ONNX Runtime's Node binding holds the JavaScript thread for the duration of an inference, and the gazetteer reads are synchronous too. We shipped a `MAILWOMAN_BATCH_CONCURRENCY` worker pool until we measured it: 1.00x, flat, from one worker to sixteen. It's gone as of 2026-07-16.

To use more cores you have to cross a thread boundary, which is what the streaming recipes below do. Expect a modest return even there: geocoding is memory- and I/O-bound on a shared multi-gigabyte database, and a measured sweep peaked at two workers. The full receipts are in [the performance reference](../plan/reference/performance.mdx).

## Skipping the endpoint entirely

If the CSV is already on the machine that has the gazetteer, HTTP is a tax. Both recipes below use [spliterator](https://github.com/sister-software/spliterator) to stream the file, so a ten-million-row export costs the same memory as a ten-row one.

### Parsing only, with no gazetteer

When you want components rather than coordinates (deduping a mailing list, normalizing a column before a join), skip the resolver. There's no database, so this needs no data root and no shards:

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

`enableQuoteHandling` is what keeps a quoted `"350 5th Ave, New York"` from splitting on its own comma, which is the failure that sends a street name into the city column. `normalizeKeys` lowercases the header so `Full Address` arrives as `full_address`.

This loop is single-threaded, and on one core it's already at about 300 addresses/second. Worker threads would help here in principle (no database to contend over), but nobody has measured it — see the performance reference before you build that.

### Full geocoding, across worker threads

Coordinates need the gazetteer, and that's the ms-scale per-row work worth putting on threads. [`geocodeStream`](https://github.com/sister-software/mailwoman/blob/main/mailwoman/geocode-stream.ts) wraps spliterator's `parallelMap`: it normalizes on the main thread and hands each row to a worker that rebuilds its own classifier, resolver, and shards.

```ts
import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/utils"
import { normalizeCSV } from "@mailwoman/registry"
import { geocodeStream } from "mailwoman/geocode-stream"
import { createNewlineWriter } from "spliterator"

const mapping = { id: "id", address: "full_address" }

const geocoded = geocodeStream(normalizeCSV("addresses.csv", { mapping }), {
	mapping,
	geocode: {
		wofDBPath: dataRootPath("wof", "admin-global-priority.db").toString(),
		dataRoot: mailwomanDataRoot().toString(),
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

Two things to know before you tune it. Records arrive in **completion order**, not input order, so carry your own `id` through and rejoin downstream rather than trusting position. And `concurrency: 2` is not a placeholder we forgot to raise: the workers contend for one multi-gigabyte database, so throughput peaks there and degrades past it, with four workers landing back at baseline. Each worker also loads its own 38 MB model. Sweep it against your data instead of reaching for `availableParallelism()`.
