# @mailwoman/spatial

Spatial analysis, geocoding, and geo-related utilities for the Mailwoman
ecosystem. Provides coordinate math, H3 hexagonal grid indexing, WKB geometry
parsing, and coordinate-string parsing.

```ts
import { haversineKm, latLngToCell, parseCoordinateString } from "@mailwoman/spatial"

// Great-circle distance
const km = haversineKm(37.7749, -122.4194, 34.0522, -118.2437) // SF → LA

// H3 grid cell
const cell = latLngToCell(37.7749, -122.4194, 9) // resolution-9 H3 index

// Parse coordinate strings
const loc = parseCoordinateString("37.7749° N, 122.4194° W")
```

## What's inside

| Capability             | Implementation                                                              |
| ---------------------- | --------------------------------------------------------------------------- |
| **Coordinate math**    | Haversine distance, bearing, bounding-box containment                       |
| **H3 indexing**        | Hexagonal grid indexing via `h3-js` — spatial blocking for the matcher      |
| **WKB/WKT geometry**   | Parse/format Well-Known Binary geometry via `wkx`                           |
| **Coordinate parsing** | Parse decimal, DMS, and UTM coordinate strings via `geo-coordinates-parser` |
| **GeoJSON**            | GeoJSON Feature/FeatureCollection types and utilities                       |

## Dependencies

- [`h3-js`](https://github.com/uber/h3-js) — Uber's hexagonal hierarchical geospatial indexing system
- [`wkx`](https://github.com/cschwarz/wkx) — Well-Known Binary geometry parser
- [`geo-coordinates-parser`](https://github.com/geops/geo-coordinates-parser) — coordinate string parsing

Optional: `@googlemaps/google-maps-services-js` for Google Maps API integration.

## Related

- [`@mailwoman/match`](../match) — uses H3 cells for geo-first record blocking
- [`@mailwoman/address-id`](../address-id) — uses H3 for stable address primary keys
- [`@mailwoman/core`](../core) — consumes spatial types

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
