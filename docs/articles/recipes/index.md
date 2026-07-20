---
sidebar_title: Overview
title: Recipes
sidebar_position: 0
hide_footer: true
role: landing
audience: product-reader
source-of-truth: self
---

Task-oriented walkthroughs for jobs people actually show up with: geocode a table, put the results on a map, keep a coordinate private. Each one states what you'll have by the end and links the reference or concept page it builds on.

- **[Point your existing stack at Mailwoman](./geopy-and-http.md)** — run the Nominatim-compatible drop-in from one `docker run`, then point the geopy (or plain-HTTP) client you already have at it, with no code change.
- **[Batch geocoding](./batch-geocoding.md)** — turn a list of addresses into a list of coordinates with one bulk request, with per-row error isolation so one bad row never sinks the batch.
- **[Displaying results on a map](./display-on-a-map.md)** — render resolved entities to a self-contained `map.html` you can open in a browser, from the same data you'd export as GeoJSON for QGIS.
- **[The free first pass](./multi-service-geocoding.md)** — run Mailwoman locally as a no-cost first geocoding pass, and spend a paid API's budget only on the residual it couldn't pin well enough.
- **[Ingesting giant CSVs](./parallel-csv-ingest.md)** — stream a multi-gigabyte CSV into normalized records on one thread, then thread only the geocoding stage that's actually expensive.
- **[Coarsening a coordinate for privacy](./privacy-coordinate-rounding.md)** — round or geohash a rooftop coordinate down to neighbourhood-level precision before it lands in an analytics table or a public dashboard.
- **[Looking up a timezone](./timezones.md)** — resolve a coordinate to its IANA timezone over a self-built point-in-polygon database.
- **[UN/LOCODE lookup](./un-locode-lookup.md)** — resolve a place name or coordinate to its UN/LOCODE trade-and-transport code, and back.
