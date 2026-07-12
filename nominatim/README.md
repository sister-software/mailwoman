# @mailwoman/nominatim

A **Nominatim-compatible HTTP geocoding API** over the [Mailwoman](https://mailwoman.sister.software) engine. Point an existing Nominatim client at it and forward + reverse geocoding work — no PostgreSQL, no `osm2pgsql` import.

```bash
npx @mailwoman/nominatim serve --port 8080 --candidate-db <gazetteer-or-bundle>
```

```python
from geopy.geocoders import Nominatim

geo = Nominatim(domain="localhost:8080", scheme="http")
geo.geocode("1600 Pennsylvania Ave NW, Washington DC", addressdetails=True)
geo.reverse((38.8977, -77.0365))
```

## Endpoints

| Endpoint        | Nominatim contract                                            | Status  |
| --------------- | ------------------------------------------------------------- | ------- |
| `/search`       | free-text `q` + structured forward geocoding                  | ✓       |
| `/reverse`      | `lat`/`lon` → nearest address (`WofReverseGeocoder` PIP)      | ✓       |
| `/status`       | health + data version                                         | ✓       |
| `/lookup`       | resolve known place ids                                       | planned |
| `/openapi.json` | emitted OpenAPI 3.1 document for search/reverse/lookup/status | ✓       |

## Library use

The package is engine-agnostic — embed it in your own server:

```ts
import { serveNode } from "@mailwoman/api-kit"
import { createNominatimApp, type NominatimEngine } from "@mailwoman/nominatim"

const engine: NominatimEngine = {/* search, reverse, lookup, status — backed by your Mailwoman pipeline */}
const app = createNominatimApp(engine)
serveNode({ fetch: app.fetch, port: 8080, hostname: "0.0.0.0" })
```

## CORS

Browser-embedded geocoder clients call this cross-origin, so the server sends permissive CORS by default — `Access-Control-Allow-Origin: *` and a `204` answer to preflight `OPTIONS`. Behind a reverse proxy that already sets the headers, turn it off with `--no-cors` (or `createNominatimApp(engine, { cors: false })`).

## Annotations

Every result carries an OpenCage-style `annotations` block — coordinate formats (DMS, MGRS, geohash,
Maidenhead, Mercator), qibla bearing, sun times, country flag, calling code, and currency, plus the IANA
timezone, UN/LOCODE, and EU NUTS codes when their data bundles are present. Plain Nominatim returns none
of these.

## Status

Shipped. `/search` and `/reverse` resolve over the live engine and return the enriched block; `/lookup`
is not yet implemented (returns `501`). `addressdetails` goes down to the house number and road when the
query carries them — `1600 Pennsylvania Avenue NW, Washington, DC 20500` resolves to the rooftop
(`38.897, -77.037`) with `house_number`, `road`, `city`, `state`, `postcode`, and `country_code`.

For autocomplete / type-ahead, see the companion [`@mailwoman/photon`](../photon).
