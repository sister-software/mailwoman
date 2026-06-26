# @mailwoman/nominatim

A **Nominatim-compatible HTTP geocoding API** over the [Mailwoman](https://mailwoman.sister.software) engine. Point an existing Nominatim client at it and forward + reverse geocoding work — no PostgreSQL, no `osm2pgsql` import.

```bash
npx @mailwoman/nominatim serve --port 8080 --data <gazetteer-or-bundle>
```

```python
from geopy.geocoders import Nominatim

geo = Nominatim(domain="localhost:8080", scheme="http")
geo.geocode("1600 Pennsylvania Ave NW, Washington DC", addressdetails=True)
geo.reverse((38.8977, -77.0365))
```

## Endpoints

| Endpoint   | Nominatim contract                                       | Status  |
| ---------- | -------------------------------------------------------- | ------- |
| `/search`  | free-text `q` + structured forward geocoding             | ✓       |
| `/reverse` | `lat`/`lon` → nearest address (`WofReverseGeocoder` PIP) | ✓       |
| `/status`  | health + data version                                    | ✓       |
| `/lookup`  | resolve known place ids                                  | planned |

## Library use

The package is engine-agnostic — embed it in your own server:

```ts
import express from "express"
import { createNominatimRouter, type NominatimEngine } from "@mailwoman/nominatim"

const engine: NominatimEngine = {
	/* search, reverse, lookup, status — backed by your Mailwoman pipeline */
}
express().use(createNominatimRouter(engine)).listen(8080)
```

## Annotations

Every result carries an OpenCage-style `annotations` block — coordinate formats (DMS, MGRS, geohash,
Maidenhead, Mercator), qibla bearing, sun times, country flag, calling code, and currency, plus the IANA
timezone, UN/LOCODE, and EU NUTS codes when their data bundles are present. Plain Nominatim returns none
of these.

## Status

Shipped. `/search` and `/reverse` resolve over the live engine and return the enriched block; `/lookup`
is not yet implemented (returns `501`). The forward `addressdetails` is admin-grained today (city / state
/ postcode / country + coordinate); street-level is a refinement.

For autocomplete / type-ahead, see the companion [`@mailwoman/photon`](../photon).
