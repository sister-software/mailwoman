---
title: Batch Geocoding
id: batch-geocoding
role: guide
audience: product-reader
source-of-truth: api/routes.ts, api/schema.ts, mailwoman/api-engine.ts
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

## Two limits to size your chunks around

The server bounds two things so a single request can't run away with it:

- **Batch size** caps at 1 000 addresses (`MAILWOMAN_BATCH_MAX`); send more in one body and you get a `413`. Chunk your ten thousand into ten requests.
- **Concurrency** inside a batch defaults to 8 workers (`MAILWOMAN_BATCH_CONCURRENCY`). The first address in a given US state warms that state's shard cache, so a batch sorted to keep same-state rows together resolves the tail of them almost for free. If your data is already grouped by region, you're getting that win without doing anything.

Both are environment overrides, so you tune them to your box rather than recompiling. Start with the defaults; raise concurrency only once you've confirmed the machine has the cores and the shard I/O to feed them.
