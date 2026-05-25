---
sidebar_position: 36
title: Falsehoods about address shapes and dimensions
tags:
  - domain
  - falsehoods
  - locality
  - international
---

# Falsehoods programmers believe about address shapes and dimensions

_An address is not necessarily a point on a map. It is not necessarily a polygon. It is not necessarily a discrete building. It is not necessarily at ground level. It is not necessarily the only address at its coordinates. And it is not necessarily stationary._

## The falsehoods

### "An address is a lat/lon point."

Postcodes, rural routes, and descriptive addresses all represent areas or paths, not points. A ZIP code centroid in rural Montana is off by 10-15 miles from any actual delivery point. The centroid is a convenience for map rendering, not a geographic truth about the address.

The US Census Bureau's ZIP Code Tabulation Areas (ZCTAs) generalize ZIP codes into polygons, but ZCTAs are explicitly NOT USPS ground truth. USPS does not publish ZIP code boundaries as polygons — they are carrier routes, not areas. A ZIP code follows the path a carrier walks. It does not enclose a region.

UK postcodes cover ~15 addresses on average — effectively points. But UK postcode sectors (the first half of the postcode, e.g., `SW1A`) cover neighborhoods. The same postcode system produces both point-level and area-level resolution depending on which part you use.

Irish Eircodes are unique per delivery point — the postcode IS the point. French postcodes correspond to commune boundaries — the postcode IS the polygon. The same concept ("postcode") has fundamentally different spatial semantics in different countries.

### "An address is a polygon."

No address is a polygon in the geospatial sense. A building footprint is a polygon. A parcel boundary is a polygon. An address is a label applied to one or more of these spatial objects, but the address itself has no shape.

Buildings with multiple addresses (apartment buildings, office towers) are one polygon with many address labels. A single-family home is one polygon with one address label. A rural route is a path with many address labels distributed along it. A PO box is an address label with no spatial object at all — it exists only at the post office counter.

Geocoders that return a polygon for an address are returning the polygon of the spatial object the address is associated with (a building, a parcel, a ZIP code approximation). The address itself is the label, not the shape.

### "An address is a discrete building."

An address can represent:

- A specific apartment within a building (same building footprint, different address).
- A floor of an office tower (same lat/lon, different vertical coordinate).
- A PO box at a post office (the address is at the post office, not at the recipient's home).
- A mailbox on a rural route (the address is a point along a path, not a building).
- A berth in a marina (the address is a slip of water between docks).
- A campsite in a national park (the address is a designated area, not a structure).
- A grid coordinate in Mannheim, Germany (`R 5, 6-13` — block R, row 5, buildings 6-13, no street).
- A distance marker: `50 miles West of Socorro, New Mexico` — no building, a point relative to a known place.
- A descriptive location: `From where the Chinese restaurant used to be, two blocks down, half a block toward the lake` — no fixed reference, entirely relational.

### "An address is at ground level."

Z-dimension matters. Buildings have floors, and different floors can have different addresses:

- **Below ground.** Basement apartments, underground parking, subway stations, wine cellars, bomb shelters, data centers. `123 Main St, Basement` is a different delivery point from `123 Main St, Apt 1` — same building footprint, different vertical position, possibly different entrance.
- **Above ground.** Floor 50 of a skyscraper. The Empire State Building has different ZIP+4 codes for different floors and tenants. A geocode to the building centroid places all addresses at the same coordinate. A geocode with floor-level resolution places Floor 50 at 200 meters above ground level — but no geocoder returns elevation data.
- **Sky lobbies.** Some skyscrapers have separate entrance lobbies at ground level and sky lobbies at transfer floors. A delivery to "85th Floor, 1 World Trade Center" may route through the sky lobby on the 64th floor, not the ground floor. The address's entrance is at elevation.
- **Underground complexes.** Tokyo Station has a city's worth of retail and office space underground, with addresses that resolve to the surface station coordinates. Montreal's RÉSO (underground city) connects 1,600 shops and 200 restaurants — all with surface addresses, all functionally underground.

### "An address doesn't share its lat/lon with another address."

A shopping mall at one lat/lon can have 100+ addresses — one per store. An office tower can have one address per floor, per suite, or per tenant. Each address shares the same horizontal coordinates but differs in vertical position or internal routing.

A marina has addresses for each berth — the berths are adjacent, not stacked, but they share approximate coordinates and differ by a few meters. A trailer park has addresses for each pad — same lat/lon to within 10 meters, differentiated by pad number.

A post office with PO boxes has hundreds of addresses (the PO box numbers) all at one lat/lon — the post office building. Geocoding a PO box to the post office building is correct at the building level but wrong for the recipient's actual location.

### "An address stays where it is."

Houseboats, ships, and mobile homes have addresses that move. A houseboat moored at a marina changes coordinates when it relocates. A cruise ship employee's address follows the ship's itinerary. A mobile home moved to a new park gets a new address even though the physical structure is the same.

Offshore platforms have addresses but not fixed coordinates relative to land. A North Sea oil platform's address is its name and block number, not a lat/lon on a standard map projection. Military forward operating bases have addresses that exist only as long as the base exists.

Douglas Perreault's condo in Florida changed address three times in a few years — same physical location, four different written addresses due to post office changes and block renaming. The address stayed still; the label moved around it.

### "An address has a street-facing entrance."

Buildings can have entrances on multiple streets (corner buildings), entrances at different elevations (hillside buildings with ground-floor entrances on different floors), or entrances that are not on the labeled street at all (rear-access buildings, alleys, internal courtyards). The address's street name may not be the street the entrance faces.

A building at the corner of Main St and Elm St might have address `123 Main St` but the delivery entrance is around the corner on Elm St. The geocoder places the coordinate on Main St. The delivery driver approaches from Elm St. Both are correct for their respective purposes.

## How traditional geocoders handled these

**libpostal** operates exclusively on text strings. It does not produce spatial output — no coordinates, no polygons, no elevation. The spatial questions are downstream of libpostal's parser. This is the correct architecture: the parser labels tokens, the resolver turns labels into spatial objects. The parser should not need to know about shapes.

**Pelias** resolves addresses to point coordinates via Elasticsearch. Multi-address buildings (apartments, malls) all resolve to the same building centroid unless the data source includes unit-level coordinates. Pelias has no concept of vertical position — Floor 50 and the basement of the same building are the same coordinate. Pelias does not model mobile addresses (houseboats, ships) or non-building addresses (rural route boxes, grid coordinates).

**Google's API** returns a location type with each geocode: `ROOFTOP` (precise to the building entrance), `RANGE_INTERPOLATED` (estimated along a street segment), `GEOMETRIC_CENTER` (centroid of a region), or `APPROXIMATE` (best guess). This is the right taxonomy — it tells the consumer the spatial precision of the result. Google's Places API returns `latitude`, `longitude`, and an optional `viewport` (bounding box) for each place, distinguishing point-level from area-level results. Google does not return elevation data for addresses.

## What the neural approach changes

**The resolver (Stage 6) returns candidates with placetypes, not just coordinates.** A WOF record has a `placetype` (country, region, locality, neighbourhood, venue) and optionally a bounding box. The resolver returns the placetype alongside the coordinate, so the downstream system knows whether it received a point for a building, a centroid for a city, or an approximate coordinate for a postcode.

**The resolver returns top-K candidates, not a single coordinate.** `Springfield` returns 34 candidates, each with a coordinate and placetype. The downstream system can display them on a map, offer a selection UI, or aggregate them statistically. The resolver does not pretend that there is one correct coordinate for an ambiguous address.

**Vertical resolution is outside Mailwoman's scope.** The schema has a `unit` tag for apartment and suite numbers, but the resolver does not model elevation. A `unit=4B` address resolves to the building centroid, not Floor 4, Unit B. Vertical resolution requires building-interior data (floor plans, unit layouts) that no open gazetteer provides. This is a commercial address verification problem (SmartyStreets, Melissa Data), not an open-source parser problem.

**Moving addresses are outside Mailwoman's scope.** A houseboat's current berth is a resolver question — the parser correctly extracts `Berth 42, Marina del Rey` as a location component, but the resolver needs a current marina database to map that to coordinates. The parser's job is structural — "this is a location reference" — not "this is where it currently is."

## What Mailwoman still can't do

- **Vertical disambiguation.** Two addresses at the same building but different floors resolve to the same coordinate. The `unit` tag preserves the floor/apartment information in the output, but the resolver does not use it for spatial disambiguation.
- **Non-building addresses.** `50 miles West of Socorro` — the parser can identify "Socorro" as a locality reference, but "50 miles West of" is a relative offset that requires spatial computation, not gazetteer lookup. Mailwoman's resolver does not compute relative offsets from gazetteer points.
- **Shape output.** The resolver returns a coordinate and optionally a bounding box from WOF. It does not return the building footprint, the parcel boundary, or the ZIP code area. Shape-level output requires a spatial database (PostGIS, Elasticsearch with geo_shape), not a SQLite point-in-polygon index.
- **Elevation data.** WOF does not include elevation. Address-level elevation requires a DEM (Digital Elevation Model) lookup at the coordinate, which is a GIS operation, not a resolver operation.

## References

- [Series overview: Falsehoods about addresses](./falsehoods-about-addresses.md)
- [Michael Tandy's original catalogue](https://www.mjt.me.uk/posts/falsehoods-programmers-believe-about-addresses/)
- [What is a postcode?](../the-problem/what-is-a-postcode.md) — postcodes as routing instructions, not polygons
- [What is a ZIP Code and how is it structured?](../the-problem/what-is-a-zip-code.md) — why ZIP codes don't have boundaries
- [How can a building have two addresses?](../the-problem/how-can-a-building-have-two-addresses.md) — the vertical dimension of addressing
