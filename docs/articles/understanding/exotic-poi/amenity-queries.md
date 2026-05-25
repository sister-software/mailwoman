---
sidebar_position: 2
title: Amenity queries
tags:
  - domain
  - venue
  - international
---

# Amenity queries

An amenity query asks for the nearest instance of a generic category. The user doesn't care which gas station — they care which one is closest, open, or cheapest. The geocoder's job is to translate a category label into a set of candidate locations and rank them.

## What amenity queries look like

| Query | Category | Implicit constraints |
|-------|----------|---------------------|
| `gas station` | `amenity=fuel` | Nearest to user's location |
| `water fountain` | `amenity=drinking_water` | Nearest, publicly accessible |
| `ATM` | `amenity=atm` | Nearest, preferably in-network |
| `restroom` | `amenity=toilets` | Nearest, publicly accessible, open |
| `mailbox` | `amenity=post_box` | Nearest, collection time not passed |
| `playground` | `leisure=playground` | Nearest, open to public |
| `pharmacy` | `amenity=pharmacy` | Nearest, open now |
| `hospital` | `amenity=hospital` | Nearest, emergency department |
| `bicycle parking` | `amenity=bicycle_parking` | Nearest, secure |
| `EV charging station` | `amenity=charging_station` | Nearest, compatible plug, available |
| `pho near me` | `cuisine=vietnamese` | Nearest Vietnamese restaurant |
| `coffee shop` | `amenity=cafe` | Nearest, open |

The query has two parts: a **category** (what kind of thing) and an **implicit location constraint** (near where the user is, or near a specified place). The category is the hard part — the geocoder must map the user's words to a category taxonomy.

## The category-taxonomy problem

"Gas station" in English maps to `amenity=fuel` in OSM's taxonomy. "Gas station" in Australian English ("servo") maps to the same tag. "Petrol station" in British English also maps to the same tag. The same physical thing — a place that sells fuel for vehicles — has multiple names, and the geocoder must recognize all of them.

The problem compounds across languages: `ガソリンスタンド` (gasorin sutando, Japanese), `加油站` (jiāyóuzhàn, Chinese), `Tankstelle` (German), `station-service` (French). Every language has its own word for "gas station." A geocoder that only recognizes English amenity names is useless for most of the world's population.

This is not a translation problem — it's an **alias** problem. The geocoder doesn't need to translate "gas station" to French. It needs to know that `station-service` is the same category as `amenity=fuel`. The category taxonomy is language-independent; the labels for each category are language-dependent.

## How traditional geocoders handle amenity queries

**Nominatim** (OSM's geocoder) handles amenity queries well because OSM tags every amenity with a standardized key-value pair. `amenity=fuel` maps to every gas station in OSM. Nominatim's search API accepts free-text queries and matches them against OSM tags and names. `gas station near Paris` returns OSM-tagged fuel stations near Paris.

The limitation: Nominatim only searches OSM. If a gas station is not in OSM, it doesn't exist to Nominatim. OSM's amenity coverage is excellent in Western Europe and sparse in much of the rest of the world. A query for `gas station` in rural India may return nothing because no one has mapped the gas stations there.

**Google's Places API** handles amenity queries through Google's proprietary place taxonomy. The API accepts a `type` parameter (e.g., `gas_station`, `atm`, `pharmacy`) and returns ranked results. Google's taxonomy is larger and more consistent than OSM's, but it is proprietary — you cannot inspect how a category is defined, add new categories, or correct misclassifications.

**Pelias** has limited amenity support. Pelias indexes OSM amenities as part of its gazetteer, but the parser does not distinguish between address queries and amenity queries. A search for `gas station` tokenizes to `[gas] [station]` and searches for those tokens in the gazetteer. If OSM has a place named "Gas Station" (a business name, not a category tag), it matches. If no business is named "Gas Station," the search returns nothing. Pelias does not map category labels to OSM tags.

## What Mailwoman does today

Mailwoman's parser will see `gas station` and try to classify the tokens as address components. The kind classifier (Stage 2.5) may recognize the input as a non-address query (no numbers, no street suffixes, no state abbreviations) and flag it as `kind=unknown`, but there is no `kind=amenity` classification path.

The resolver (Stage 6) indexes WOF administrative places, not OSM amenities. A search for `gas station` in the current resolver returns nothing — WOF does not have gas stations.

**Amenity queries are out of scope for Mailwoman's current architecture.** They require:

- A **category alias table** mapping user-facing labels to OSM tags (or another taxonomy).
- A **POI index** (OSM amenities, franchise locations, or a commercial dataset).
- A **proximity resolver** that can answer "nearest X to location Y" queries.

These are planned for a future phase but are not part of the current implementation.

## See also

- [Franchise and brand queries](./franchise-queries.md) — the named-chain version of amenity queries
- [Regional variant queries](./regional-variant-queries.md) — when the same amenity has different names
- [Exotic POI overview](./exotic-point-of-interest-queries.md) — the series index
