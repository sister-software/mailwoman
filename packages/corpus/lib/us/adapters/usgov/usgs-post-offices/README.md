# `usgov-usgs-post-offices` adapter

The post offices in the USGS National Map structures layer, each rendered as its name followed by its
street address. Public domain.

## Source

Layer 38, `Post Offices`, of the National Structures Dataset's MapServer at
`https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer`. The adapter reads the
features whose feature code is 78006, the United States Postal Service facilities across the states,
the District of Columbia and the five primary territories. The scratch pull of 2026-11-09 returned
31,033 of them.

Fetch it with:

```sh
mailwoman corpus fetch usgs-post-offices
```

The fetcher counts the features, pages the query 2,000 at a time by `resultOffset` in `OBJECTID`
order, and refuses a pull whose size differs from the count. It writes three files under
`$MAILWOMAN_CACHE_ROOT/sources/usgov-usgs-post-offices/`:

| File                    | Contents                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `post-offices.geojsonl` | One GeoJSON feature per line, with the field names in lower case         |
| `service.json`          | The MapServer description: the publisher's terms and refresh date        |
| `MANIFEST.json`         | Query, feature count, byte count, sha256, and the service's refresh text |

## ZIP Codes

The fetcher writes `zipcode` as a string, so Puerto Rico's `00725` keeps its leading zeros. Where the
state is one the codex knows, the value passes through `normalizeZIPCode`: a numeric value that lost
its zeros is padded back when its first digit matches the state, and a value that isn't a ZIP Code
reads `null`. The published value is kept as `zipcode_published` whenever the two differ.

## Rows

| Field                  | Component                                      |
| ---------------------- | ---------------------------------------------- |
| `name`                 | `venue`                                        |
| `address`              | `house_number`, `street`, `unit` or `po_box`   |
| `city`                 | `locality`                                     |
| `state`                | `region`                                       |
| `zipcode`              | `postcode`                                     |
| `permanent_identifier` | `source_id`, as `usgov-usgs-post-offices-<id>` |

`venue` is inserted first, so alignment claims its span before `locality` searches for its own: the
words `Palm Bay` in `Palm Bay West Post Office` are venue, and the later `Palm Bay` is the locality.

A feature with no street address, city, recognized state or ZIP Code yields no row. Two features in
the 2026-11-09 pull have no street address.

## License

A work of the United States Government, public domain under 17 U.S.C. § 105. The service's own
description calls the layer "public domain structures data". Each row's `license` is `Public Domain`.
`readLicenseRecord` resolves that label to `LicenseRef-USGov-Public-Domain`.
