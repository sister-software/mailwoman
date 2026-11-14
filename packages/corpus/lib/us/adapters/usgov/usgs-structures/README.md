# `usgov-usgs-structures` adapter

The USGS National Structures Dataset: schools, colleges, hospitals, fire, police and ambulance
stations, prisons, courthouses, town halls, state capitols, post offices, cemeteries and recreation
sites, each rendered as its name followed by its street address. Public domain.

## Source

The point layers of the National Structures Dataset's MapServer at
`https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer`, across the states, the
District of Columbia and the five primary territories. `lib/us/structures/usgs/layers.ts` lists each
layer with its slug, its POI taxonomy category and whether it trains.

The service publishes every layer twice. Layers 0–34 are the `Labels` group and serve the same rows as
the `Features` layers 35 ids above them, so only the `Features` layers 37–67 are read. Layer 69,
`Alaska Pipeline`, holds polylines with no name, address or identifier and is left out. A feature code
isn't unique to a layer (Campgrounds and Shelters both use feature code 82008), so each layer is queried by its id.

Fetch it with:

```sh
mailwoman corpus fetch usgs-structures
```

The fetcher asks each layer for its feature count, then pages it 2,000 at a time by `OBJECTID`, each
page asking for the features past the last `OBJECTID` read. It refuses a pull whose size for any layer
differs from that layer's count. It writes three files under
`$MAILWOMAN_CACHE_ROOT/sources/usgov-usgs-structures/`:

| File                  | Contents                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `structures.geojsonl` | One GeoJSON feature per line, with the field names in lower case and its layer id and slug |
| `service.json`        | The MapServer description: the publisher's terms and refresh date                          |
| `MANIFEST.json`       | Feature counts per layer and in total, byte count, sha256, and the service's refresh text  |

Each feature keeps `objectid`, `permanent_identifier`, `fcode`, `gnis_id`, `name`,
`addressbuildingname`, `address`, `city`, `state`, `zipcode`, `loaddate` (an ISO date) and
`source_originator`.

## ZIP Codes

The fetcher writes `zipcode` as a string, so Puerto Rico's `00725` keeps its leading zeros. Where the
state is one the codex knows, the value passes through `normalizeZIPCode`: a numeric value that lost
its zeros is padded back when its first digit matches the state, and a value that isn't a ZIP Code
reads `null`. The published value is kept as `zipcode_published` whenever the two differ.

## Rows

| Field                  | Component                                    |
| ---------------------- | -------------------------------------------- |
| `name`                 | `venue`                                      |
| `address`              | `house_number`, `street`, `unit` or `po_box` |
| `city`                 | `locality`                                   |
| `state`                | `region`                                     |
| `zipcode`              | `postcode`                                   |
| `permanent_identifier` | `source_id`, as `usgov-usgs-structures-<id>` |

`venue` is inserted first, so alignment claims its span before `locality` searches for its own: the
words `Palm Bay` in `Palm Bay West Post Office` are venue, and the later `Palm Bay` is the locality.

A feature with no street address, city, recognized state or ZIP Code yields no row. Of the 542
addressed cemeteries in a 600-feature sample drawn on 2026-11-13, 119 addresses began with a digit and
423 didn't. An address with no house number, such as `Lebanon Road`, trains as a street. The recreation layers
(campgrounds, trailheads, cabins, shelters, picnic areas) and the historic-site layer sometimes have an address
for a remote site's access road. The adapter produces no training row from those layers. Their records serve
retrieval through the structures layer only.

## License

A work of the United States Government, public domain under 17 U.S.C. § 105. The service's own
description calls the dataset "public domain structures data". Each row's `license` is `Public Domain`.
`readLicenseRecord` resolves that label to `LicenseRef-USGov-Public-Domain`.
