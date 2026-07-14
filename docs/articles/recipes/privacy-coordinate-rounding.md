---
title: Coarsening a Coordinate for Privacy
id: privacy-coordinate-rounding
role: guide
audience: product-reader
source-of-truth: spatial/coordinate-formats.ts
---

You geocoded a customer's address and got a rooftop coordinate back — accurate to a few metres. That precision is the whole point when you're routing a driver to the door. It's a liability when you're about to store the point in an analytics table, share it with a partner, or plot a thousand customers on a public dashboard. A rooftop point _is_ the house; you usually want the neighbourhood.

So coarsen it on purpose. You have two ways to do it, and the only real decision is how much accuracy you're willing to give up.

## Round the decimal degrees

The cheapest coarsening is to drop decimal places. Each one you keep is worth roughly 10× the precision:

| Decimals | Cell size | What it pins      |
| -------- | --------- | ----------------- |
| 5        | ~1 m      | the doormat       |
| 4        | ~11 m     | the building      |
| 3        | ~110 m    | the block         |
| 2        | ~1.1 km   | the neighbourhood |
| 1        | ~11 km    | the city          |

```ts
const round = (n: number, decimals: number) => {
	const f = 10 ** decimals
	return Math.round(n * f) / f
}

// A rooftop point coarsened to the neighbourhood.
const coarse = { lat: round(result.lat, 2), lon: round(result.lon, 2) }
// { lat: 40.75, lon: -73.99 }
```

The catch with rounding is that the cell it lands in depends on where the point sits relative to the grid — two houses on the same street can round into different 0.01° cells. If you need every point in a region to collapse to the _same_ coarse location, reach for a geohash instead.

## Truncate a geohash

A geohash encodes a coordinate as a string where every character you drop widens the cell it names. `@mailwoman/spatial` ships the encoder, so you pick a precision and hand back the cell:

```ts
import { toGeohash } from "@mailwoman/spatial"

toGeohash(40.7484, -73.9857) // precision 9 ≈ 4.8 m: "dr5ru6j28"
toGeohash(40.7484, -73.9857, 5) // ≈ 4.9 km: "dr5ru"
```

| Precision   | Cell size |
| ----------- | --------- |
| 9 (default) | ~4.8 m    |
| 7           | ~153 m    |
| 6           | ~1.2 km   |
| 5           | ~4.9 km   |
| 4           | ~39 km    |

Because the cell boundaries are fixed, every address inside `dr5ru` shares the prefix — you can group, join, or count by the truncated string and know that two records in the same cell really are neighbours. Store the geohash, not the point, and the precision you didn't keep is precision you can't leak.

One thing to name plainly: coarsening is one-way by design, but it is not anonymity. A precision-6 cell over a rural address can still hold exactly one house. If the guarantee you need is "this point cannot be traced to a person," coarsening is a layer, not the whole answer — pair it with aggregation thresholds (suppress any cell with fewer than _k_ records) before anything goes public. See [Privacy policy & legal posture](../licensing/privacy.md) for where Mailwoman's own data-handling design sits relative to this.
