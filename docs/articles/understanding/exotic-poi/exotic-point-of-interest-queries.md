---
sidebar_position: 1
title: Exotic point-of-interest queries
tags:
  - domain
  - venue
  - international
  - multilingual
---

# Exotic point-of-interest queries

Not every geocoder query is an address. A large fraction of real-world searches ask for **points of interest** — named places, categories of things, brands, landmarks, and transit infrastructure. "Find the nearest gas station" is not an address. "Where is the Eiffel Tower?" is not an address. "Show me every Hilton in Manhattan" is not an address.

These queries are structurally different from address queries. An address has ordered components (number, street, city, state, postcode) with predictable patterns. A POI query is a name, a category, or a category with a location constraint. The parser that handles `350 5th Ave, New York, NY 10118` will fail on `water fountain near me` — not because the parser is broken, but because the input is a fundamentally different kind of query.

This series catalogues the categories of POI queries, how traditional geocoders handle them, and what Mailwoman's architecture does (and doesn't) do for each.

## The categories

| Query type                                         | Example                                                 | What the user wants                                                |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| [Amenities](./amenity-queries.md)                  | water fountain, gas station, ATM, restroom              | The nearest instance of a generic category                         |
| [Franchises and brands](./franchise-queries.md)    | Walmart, McDonalds, Hilton, Starbucks                   | The nearest or all locations of a named chain                      |
| [Regional variants](./regional-variant-queries.md) | servo, bodega, マクド, off-licence, chemist             | The same thing as an amenity or brand, but using local terminology |
| [Landmarks](./landmark-queries.md)                 | Eiffel Tower, Golden Gate Bridge, Empire State Building | A specific named place, usually unique or nearly unique            |
| [Transit](./transit-queries.md)                    | subway station, bus stop, airport, train station        | A transit facility, named or unnamed                               |

## Why this matters for Mailwoman

Mailwoman's parser is designed for address strings. Its output is `{house_number: 123, street: Main St, locality: Springfield, region: IL}` — structured address components. A POI query like `gas station` has none of these components. The parser will try to classify `gas` and `station` as address components (street? locality? venue?) and produce a low-confidence parse.

The right behavior for a POI query is:

1. **Recognize that it's a POI query, not an address.** The kind classifier (Stage 2.5) already does this for basic categories: `postcode_only`, `structured_address`, `intersection`. POI queries need a new kind: `amenity`, `franchise`, `landmark`.
2. **Extract the POI type and location constraints.** `gas station near Springfield, IL` → POI type = `fuel`, location = `Springfield, IL`. The location constraint can be an address or place name, which Mailwoman can parse normally.
3. **Resolve against a POI database.** The resolver needs a POI index (OSM amenities, WOF venues, a franchise location dataset) to answer "nearest gas station." Mailwoman's resolver currently indexes administrative places, not POIs.

POI queries are the next frontier for Mailwoman after address parsing stabilizes. The architecture supports them — the staged pipeline can route POI queries to a different resolver — but the infrastructure (POI index, POI kind classifier, regional variant aliases) is not yet built.

## See also

- [What is an address?](../the-problem/what-is-an-address.md) — the boundary between addresses and POIs
- [Why a neural parser?](../our-approach/why-a-neural-parser.md) — the architecture that could handle both
- [The knowledge ladder](../our-approach/the-knowledge-ladder.md) — where query-type classification fits in the pipeline
