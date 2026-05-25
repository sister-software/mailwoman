---
sidebar_position: 10
title: Who's On First — data model and gotchas
tags:
  - concepts
  - resolver
  - gazetteer
  - wof
---

# Who's On First — data model and gotchas

Who's On First (WOF) is the best open gazetteer available. It's also one of the strangest datasets you'll encounter as a developer. This article documents the gotchas — the structural quirks that trip up new consumers — and the tooling Mailwoman built to work around them.

If you just want to understand how Mailwoman's resolver queries WOF at runtime, see [Resolver and Who's On First](./resolver-and-wof.md). For the build-time ingest pipeline, see [WOF data pipeline](./wof-data-pipeline.md). This article is about the data model itself.

## What WOF is

WOF is a gazetteer — a structured database of **places**. Not addresses, not roads, not buildings. _Places_: countries, regions, counties, cities, neighbourhoods, venues. Each record gets:

- A stable numeric ID
- A parent-child hierarchy
- Multilingual name variants
- A polygon geometry (bounding box)

It was created by [Mapzen](https://en.wikipedia.org/wiki/Mapzen) (2018) as the successor to GeoPlanet (Yahoo's gazetteer). The data lives on GitHub as approximately 100 repositories under the [`whosonfirst-data`](https://github.com/whosonfirst-data) org — several million individual GeoJSON files. [Geocode Earth](https://data.geocode.earth/wof/dist/sqlite/) maintains the canonical SQLite distributions.

The key thing WOF gives you that no other open dataset provides: **a consistent hierarchy with stable IDs**. You can take a locality (`Houston`, id `85922029`), follow its `parent_id` to a region (`Texas`, id `85688753`), follow _that_ to a country (`United States`, id `85633793`), and know the chain is consistent. OpenStreetMap doesn't give you this. GeoNames gives you a partial version. WOF gives you the whole thing, with an opinion on how the world's administrative boundaries nest.

## The gotchas

### One file per place

WOF's canonical storage is one `.geojson` file per place, organized in a directory tree. A US admin subset has roughly 120,000 individual files. The French equivalent has about 80,000. Opening, parsing, and indexing 200,000 JSON files is a meaningful engineering problem before you've asked a single query.

This layout made sense for WOF's original use case — git-trackable changes to individual places. But for a geocoder that needs to query "all localities named Houston" across 120K files, it's the wrong access pattern. The SQLite distributions from Geocode Earth exist precisely to solve this.

### The property namespace explosion

A WOF GeoJSON feature's `properties` object uses namespaced keys:

```json
{
	"wof:id": 85830005,
	"wof:name": "Lawrence Corner",
	"wof:placetype": "neighbourhood",
	"wof:parent_id": 1729442683,
	"wof:country": "US",
	"wof:hierarchy": [
		{
			"continent_id": 102191575,
			"country_id": 85633793,
			"county_id": 102085493,
			"localadmin_id": 404477193,
			"locality_id": 1729442683,
			"neighbourhood_id": 85830005,
			"region_id": 85688689
		}
	],
	"name:eng_x_preferred": ["Lawrence Corner"],
	"name:eng_x_variant": ["Lawrence Cor"],
	"src:geom": "quattroshapes",
	"edtf:inception": "uuuu",
	"edtf:cessation": "uuuu",
	"geom:area": 0.000047,
	"geom:bbox": "-74.73,40.08,-74.72,40.09",
	"mz:hierarchy_label": 1
}
```

Key observations:

- **Namespaced keys everywhere.** `wof:`, `name:`, `src:`, `edtf:`, `geom:`, `mz:` — each prefix is a different source or concern. The schema is flat (one object, no nesting) with meaning encoded in the key name.
- **Name variants are language-coded.** `name:eng_x_preferred` is the preferred English name. `name:fra_x_preferred` is French. `name:zho_x_preferred` is Chinese. The `_x_` separator splits the language code from the name kind.
- **Name kinds vary.** `preferred`, `variant`, `colloquial`, `abbr`, `short`. A single place can have entries for several of these per language. A major city like Paris has `name:` entries in 50+ languages; a rural US neighbourhood might have only one.
- **The hierarchy is pre-computed.** Instead of walking `parent_id` up the tree at query time, WOF bakes the full ancestry chain into each record. Convenient for display; redundant for storage; occasionally stale when a parent is reclassified.

### Brooklyn Integers

WOF IDs are issued by a service called [Brooklyn Integers](https://brooklynintegers.com/) — a distributed ID generator that guarantees uniqueness across the dataset. The IDs are not sequential, not geographically meaningful, and not sortable. They're just unique numbers. This is fine for lookup but means you can't reason about "nearby" places by ID proximity or infer anything from the numeric value.

### Supersession chains

Places get deprecated — a neighbourhood is absorbed by a neighbouring one, a county boundary changes, a locality is merged. WOF tracks this via `wof:superseded_by` arrays. A query that doesn't check supersession may return a place that hasn't existed since 2015. Every consumer needs to follow the supersession chain to the current record.

### Parent ID holes

- `parent_id: -1` — "we don't know the parent." The first French postalcode dataset was ingested with `parent_id: -1` for every record, making hierarchy traversal useless until someone manually assigned parents. Some records still have `-1`.
- `parent_id: 0` — "no parent (this is a continent or Earth itself)."
- `parent_id: 1` — Earth (the root of all hierarchy).

A query that assumes every record has a valid parent chain will fail silently on these cases.

### Name normalisation is load-bearing

WOF stores "São Paulo" with the accent. User input might arrive as "Sao Paulo" or "SAO PAULO". Case folding and accent stripping are not optional — they are required for matching. The resolver's placename index normalises all names to a canonical form (NFC, lowercase, accent-stripped) before insertion.

## How Mailwoman uses WOF

Mailwoman needs WOF for two distinct access patterns:

### 1. Rule classifiers — "is this token a known place name?"

The `whos_on_first` rule classifier answers "is this string a locality/region/country name in any language?" It doesn't need coordinates, hierarchy, or geometry — just the normalised string and which languages it's valid in.

**`WOFPlacenameCache`** builds this index by streaming GeoJSON files, extracting `name:*` properties, normalising them, and inserting into an in-memory `Map<string, Set<language>>` keyed by the normalised form.

### 2. Reconcile concordance — "do these components form a valid parent chain?"

Stage 5 joint decoding scores parse candidates against the gazetteer's hierarchy. The reconciler needs richer queries: "give me all localities named Houston with their parent_id chains" and "walk this locality's parent_id up to region — does it reach Texas?"

**`PlacetypeDataSource`** is a SQLite database per (placetype, language) pair:

```sql
CREATE TABLE records (
  id        INTEGER NOT NULL,
  src       TEXT NOT NULL,
  name      TEXT NOT NULL,
  preferred TEXT,
  variant   TEXT,
  colloquial TEXT,
  abbr      TEXT,
  short     TEXT,
  parent_id INTEGER,
  PRIMARY KEY (id, src, name)
);
```

One row per name variant. "Saint Petersburg", "St. Petersburg", and "St Petersburg" are three rows for the same `id` in different `name`/`variant`/`short` columns. The reconciler can match any variant form and get the same `parent_id` chain.

### Ingest tooling

Processing 120K GeoJSON files is an embarrassingly-parallel problem. Mailwoman's WOF ingest pipeline uses [Piscina](https://github.com/piscinajs/piscina) (a Node.js worker-thread pool) to dispatch files across all available CPU cores. Each worker reads a GeoJSON file, calls `pluckPlacetypeSpec` to extract structured fields and name variants, and upserts into the appropriate `PlacetypeDataSource`.

When the data arrives as a single bulk NDJSON dump rather than individual files, `AsyncSpliterator.asMany(source, delimiter, concurrency)` splits the file into N byte-range chunks, snaps to delimiter boundaries, and returns N independent async iterators for parallel processing. It's built but not yet exercised at scale.

For full details on the ingest pipeline, see [WOF data pipeline](./wof-data-pipeline.md).

## Why this matters for geocoding

Every geocoder needs a gazetteer. The options are:

- **Pay for one** — Google, HERE, Mapbox
- **Use an open one** — WOF, GeoNames, OSM Nominatim
- **Build your own** — BAN (France), NAD (US), TIGER (US)

WOF is the best open option for hierarchy and multilingual names. But it's hard to use raw. The per-file layout, flat namespace, supersession chains, and `parent_id: -1` holes are each a trap for a naive consumer. The tooling Mailwoman built — `WOFPlacenameCache`, `PlacetypeDataSource`, the Piscina pipeline, `AsyncSpliterator.asMany` — closes the gap between "WOF exists" and "WOF is usable as a geocoder component."

## See also

- [Who's On First on GitHub](https://github.com/whosonfirst-data) — the source repos
- [Geocode Earth WOF distributions](https://data.geocode.earth/wof/dist/sqlite/) — pre-built SQLite files
- [Spelunker](https://spelunker.whosonfirst.org/) — the official WOF browser
- [Resolver and Who's On First](./resolver-and-wof.md) — how the runtime resolver queries WOF
- [WOF data pipeline](./wof-data-pipeline.md) — build-time ingest architecture
- [Taming Who's On First](/blog/taming-whosonfirst) — the narrative version of this article
