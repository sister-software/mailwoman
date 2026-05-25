---
sidebar_position: 6
title: Transit queries
tags:
  - domain
  - venue
  - international
---

# Transit queries

A transit query names a station, stop, airport, terminal, or interchange. The user wants to find the transit facility — to depart from it, arrive at it, or navigate near it. Transit queries sit between landmark queries (named stations are landmarks) and amenity queries (unnamed bus stops are amenities).

## What transit queries look like

| Query                       | Type                                                         |
| --------------------------- | ------------------------------------------------------------ |
| Grand Central Terminal      | Named station — unique, well-known                           |
| Shibuya Station             | Named station — major hub, multiple exits                    |
| Heathrow Airport            | Named airport — large area, multiple terminals               |
| bus stop #4521              | Numbered stop — not a name, a route identifier               |
| Metro Center (DC Metro)     | Named station — multiple cities have a "Metro Center"        |
| Tokyo Station               | Named station — massive complex, underground city            |
| Port Authority Bus Terminal | Named terminal — multiple carriers, multiple levels          |
| ferry terminal              | Generic — which one?                                         |
| JFK                         | Airport code — three letters, globally unique                |
| LHR T5                      | Airport code + terminal — specific part of a larger facility |
| the train station           | Implicit — "the" train station where the user is             |

Transit queries have more structural variety than amenity queries. They can be named (Grand Central), coded (JFK), numbered (bus stop #4521), or implicit ("the train station"). The geocoder must handle all of these forms.

## The station-as-multi-point problem

A major transit station is not a point. It is a complex with multiple entrances, exits, platforms, and often an entire underground or above-ground city:

- **Shibuya Station** (Tokyo) has 6 exits, multiple train and subway lines, a bus terminal, and a surrounding commercial district. The "station" is a neighborhood-scale complex. A single coordinate for "Shibuya Station" is wrong for any specific use — the Hachikō exit is 200 meters from the New South exit, and the wrong exit can mean a 10-minute walk in the wrong direction.
- **Tokyo Station** has an underground city with shopping, dining, and office space. The Marunouchi exit faces the Imperial Palace; the Yaesu exit faces the business district. Same station, different worlds.
- **Heathrow Airport** has 5 terminals connected by train. A query for "Heathrow" could mean any terminal. A query for "Heathrow T5" is specific. The geocoder should return the airport centroid for the former and Terminal 5's coordinates for the latter.
- **Port Authority Bus Terminal** (New York) has multiple levels, multiple carriers, and gates numbered by floor. The "station" is a building; the "gate" is a specific point within it.

Transit stations need a **hierarchical model**: station → entrance/exit → platform/gate. Most geocoders only model the station level. A user searching for "Shibuya Station Hachikō exit" needs entrance-level precision. Most geocoders return the station centroid.

## The station-name ambiguity problem

Many cities have stations with the same name:

- "Union Station" exists in Washington DC, Los Angeles, Chicago, Toronto, and dozens of other cities.
- "Central Station" exists in most major cities worldwide.
- "Metro Center" is a station name in the DC Metro, but "metro center" is also a generic term for a transit hub.

The station name alone is not unique. The geocoder needs the city context to disambiguate — "Union Station, Washington DC" vs "Union Station, Los Angeles." This is the same problem as "Springfield" ambiguity, but for transit infrastructure.

Airport codes (JFK, LHR, NRT, CDG, DXB) are globally unique three-letter IATA codes. A query for "JFK" unambiguously means John F. Kennedy International Airport in New York. Airport codes are the most machine-friendly transit identifiers — short, globally unique, and standardized.

## The implicit-station problem

"The train station" without a city name implies "the train station where the user is." The geocoder needs the user's location to resolve this. This is not a parsing problem — it's a context problem. The parser correctly identifies "train station" as a transit query. The resolver needs a location to search near. Without one, the query is unresolvable.

"Subway station near me" is the same pattern: transit category + implicit location. The geocoder needs the user's location to answer it.

## How traditional geocoders handle transit queries

**Google's Places API** handles transit queries well. Stations, airports, and transit hubs are first-class place types. Google's transit data includes station entrances and exits (where available from local transit agencies) and airport terminal coordinates. "Shibuya Station" returns a coordinate for the station; Google Maps shows individual exits as separate markers.

**Nominatim** handles transit through OSM's transit tagging (`railway=station`, `aeroway=aerodrome`, `public_transport=station`). OSM station data is excellent in well-mapped areas — individual platforms, entrances, and exits are often tagged. Station name ambiguity is handled through the OSM hierarchy: the station's containing city is part of the OSM record.

**Pelias** indexes transit stations through OSM and WOF. WOF has transit stations as `venue` or `campus` placetypes. The data is as good as the underlying OSM contribution in each area. Station entrance data is sparse outside of major cities.

## What Mailwoman does today

Mailwoman's resolver indexes WOF administrative places plus a limited set of WOF venues. Transit stations that exist in WOF are resolvable; stations that don't are not. Airport codes (JFK, LHR) are not in WOF's name index — WOF uses full names ("John F. Kennedy International Airport"), not codes.

The parser handles transit queries as a mixed case: a named station like "Grand Central Terminal" looks like a venue query. An unnamed transit query like "bus stop" looks like an amenity query. The kind classifier should route transit queries to a transit-aware resolver, but this routing does not exist.

**Transit queries are partially in scope** (same as landmarks) but underserved. The venue classifier and WOF venue records cover named stations in well-populated WOF regions. Station entrance data, airport code resolution, and numbered-stop resolution are not supported.

## See also

- [Landmark queries](./landmark-queries.md) — named stations as landmarks
- [Amenity queries](./amenity-queries.md) — unnamed stops as amenities
- [Exotic POI overview](./exotic-point-of-interest-queries.md) — the series index
