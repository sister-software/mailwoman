---
title: Batch Geocoding
id: batch-geocoding
---

You have a spreadsheet — ten thousand addresses, a CSV a colleague dropped in Slack, a nightly export from your CRM — and you want a coordinate for every row. Firing ten thousand individual requests works, but you'll spend most of the wall-clock time on HTTP overhead and you'll have to write the concurrency control yourself. The Mailwoman server has a bulk endpoint for exactly this.

## The endpoint

`POST /api/batch` takes a JSON body of `{ addresses: string[] }` and returns `{ results }` in the **same order you sent them**:

```bash
curl -s localhost:3000/api/batch \
  -H 'content-type: application/json' \
  -d '{"addresses": ["350 5th Ave, New York, NY 10118", "Vienna, Austria", ""]}'
```

```json
{
	"results": [
		{
			"input": "350 5th Ave, New York, NY 10118",
			"lat": 40.7484,
			"lon": -73.9857,
			"resolution_tier": "interpolated",
			"...": "..."
		},
		{ "input": "Vienna, Austria", "lat": 48.2083, "lon": 16.3725, "resolution_tier": "admin", "...": "..." },
		{ "input": "", "error": "..." }
	]
}
```

Order is the contract that makes the bulk path usable: zip the `results` array straight back onto your input rows by index, no join key required.

## One bad row never fails the batch

The third address above was empty, so its slot carries an `{ input, error }` instead of a coordinate. That's the whole isolation model — a row that throws is caught and parked in its own slot, and the other 9 999 rows still come back. So the one check you can't skip is per-row:

```ts
const res = await fetch("http://localhost:3000/api/batch", {
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
