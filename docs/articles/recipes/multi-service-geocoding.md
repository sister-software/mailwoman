---
title: The Free First Pass
id: multi-service-geocoding
---

You have a table of addresses and a hosted geocoder that bills per request — every request, easy row or hard. At today's list prices that's somewhere between twenty cents and five dollars per thousand, depending on the provider and your volume. Multiply it out: a million-row table is $200 to $5,000 **per pass**, and if the table refreshes nightly, you buy it again tomorrow. The no-cost route caps you on rate instead: the public Nominatim server asks for at most one request per second, which puts the same million rows at eleven days.

None of that is a complaint about the services. OpenCage wraps aggregated open data in a pleasant API with friendly storage terms; Google's rooftop coverage is hard to beat; the public Nominatim instance is a donation to the commons that deserves the gentle use its policy asks for. The waste is on your side of the wire: most rows in a real table are ordinary, well-formed addresses that don't need a premium answer, and each one bills like the hard ones.

So don't send them. Run Mailwoman on your own hardware as the first pass over everything, and spend money only on the residual — the rows the free pass couldn't pin well enough for your use case. What makes the cascade practical is that Mailwoman's result tells you, per row, how good its answer is.

## Pass one: everything, locally

Geocode the whole table against your own server. [Batch geocoding](./batch-geocoding.md) covers the endpoint; [Ingesting giant CSVs](./parallel-csv-ingest.md) covers the streaming path for files that don't fit in memory.

```ts
const res = await fetch("http://localhost:3000/api/batch", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ addresses }),
})
const { results } = await res.json()
```

A local pass costs CPU time and nothing else, so "geocode all of it, twice if you like" is, for once, a perfectly reasonable plan.

## The routing decision

Every result carries a `resolution_tier` plus a calibrated `uncertainty_m` radius. The tier is one of `address_point` (a rooftop or parcel point), `interpolated` (a house-number estimate along the street), or `admin` (a locality or region centroid). Together they are the routing decision, made explicit per row. Partition on it:

```ts
const kept = []
const residual = []

for (const row of results) {
	// Escalate what your use case can't accept. Here: anything without a
	// street-level point. If city centroids are fine for you, keep the
	// admin tier too and the residual shrinks further.
	if ("error" in row || row.lat === null || row.resolution_tier === "admin") {
		residual.push(row.input)
	} else {
		kept.push(row)
	}
}
```

If you'd rather think in metres than tiers, `uncertainty_m` is the same decision as a number: escalate anything `null` or above your threshold.

How big is the residual? Measure it: take a thousand-row sample and count. US street-level is where Mailwoman is strongest today, so a US table typically leaves a small residual; elsewhere more rows land at the admin tier, which is exactly what this partition is for. Whatever the number comes out to, every row in `kept` is a row you didn't buy.

## Pass two: spend the budget on the residual

Send what's left to the hosted geocoder of your choice. OpenCage fits this slot well — one key in front of aggregated open data, and a trial tier generous enough to validate the cascade before you subscribe:

```ts
async function escalate(address: string) {
	const url = new URL("https://api.opencagedata.com/geocode/v1/json")
	url.searchParams.set("q", address)
	url.searchParams.set("key", process.env.OPENCAGE_API_KEY!)
	url.searchParams.set("limit", "1")

	const res = await fetch(url)
	const { results } = await res.json()

	return results[0] ?? null
}
```

Run the residual sequentially, or at whatever rate your plan allows. This is the one stage of the pipeline where a rate limit doesn't hurt, because the cascade already shrank the work to fit inside it.

## Cache what you buy

A paid answer you fetch twice is a bug. Key a cache on the input address (run it through `@mailwoman/normalize` first, so trivial variants collapse to one entry) and check it before escalating. One caveat worth reading the fine print for: storage terms differ. OpenCage lets you store results indefinitely and says so plainly; some providers require you to treat results as ephemeral and re-query instead. The cascade compounds with friendly storage terms — a small residual, bought once, stays bought.

## What "free" actually costs

Name both sides. The first pass isn't free to stand up: you're hosting a server and its data bundles (the gazetteer, plus per-state address-point shards if you want US rooftop answers), which means a multi-gigabyte download and a box with some RAM. Free per row, not free to run. If you geocode a few hundred addresses a month, skip all of this and use a hosted API directly; the cascade earns its moving parts when volume times refresh rate makes the per-row meter the thing you're optimizing.
