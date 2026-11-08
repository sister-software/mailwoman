# @mailwoman/spatial

Spatial analysis, geocoding, and geo-related utilities for the Mailwoman
ecosystem. Provides coordinate math, H3 hexagonal grid indexing, WKB geometry
parsing, and coordinate-string parsing.

```ts
import { haversine, latLngToCell, parseCoordinateString } from "@mailwoman/spatial"

// Great-circle distance
const km = haversine(37.7749, -122.4194, 34.0522, -118.2437) // SF → LA

// H3 grid cell
const cell = latLngToCell(37.7749, -122.4194, 9) // resolution-9 H3 index

// Parse coordinate strings
const loc = parseCoordinateString("37.7749° N, 122.4194° W")
```

## What's inside

| Capability             | Implementation                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ |
| **Coordinate math**    | Haversine distance, direction, bounding-box containment                              |
| **H3 indexing**        | Hexagonal grid indexing via `@sister.software/h3` — spatial blocking for the matcher |
| **WKB/WKT geometry**   | Parse/format Well-Known Binary geometry via `wkx`                                    |
| **Coordinate parsing** | Parse decimal, DMS, and UTM coordinate strings via `geo-coordinates-parser`          |
| **GeoJSON**            | GeoJSON Feature/FeatureCollection types and utilities                                |

## Dependencies

- [`@sister.software/h3`](https://github.com/sister-software/h3) — a Rust/WebAssembly implementation of Uber's H3 hexagonal hierarchical geospatial index
- [`wkx`](https://github.com/cschwarz/wkx) — Well-Known Binary geometry parser
- [`geo-coordinates-parser`](https://github.com/geops/geo-coordinates-parser) — coordinate string parsing

- [`@types/google.maps`](https://www.npmjs.com/package/@types/google.maps) — type declarations for the Google Maps `LatLngLiteral` shape that `GeoPoint` accepts and returns

## Related

- [`@mailwoman/match`](../match) — uses H3 cells for geo-first record blocking
- [`@mailwoman/address-id`](../address-id) — uses H3 for stable address primary keys
- [`@mailwoman/core`](../core) — consumes spatial types
- [`@mailwoman/codex/country`](../codex/country) — ISO 3166-1 country codes and names.

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html)
