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

| Endpoint   | Nominatim contract                                         | Status       |
| ---------- | ---------------------------------------------------------- | ------------ |
| `/search`  | free-text `q` + structured forward geocoding               | #802         |
| `/reverse` | `lat`/`lon` → nearest address (wires `WofReverseGeocoder`) | #803         |
| `/lookup`  | resolve known place ids                                    | #805         |
| `/status`  | health + data version                                      | scaffolded ✓ |

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

## Status

**Scaffold** (epic [#801](https://github.com/sister-software/mailwoman/issues/801)). The router, parameter
parsing, and response types are in place; the server boots and answers `/status`. The real engine
wiring + the Nominatim result formatter are tracked in #802–#805 and #809. See
["Migrating from Nominatim"](https://mailwoman.sister.software) (#808) once published.

For autocomplete / type-ahead, see the companion [`@mailwoman/photon`](../photon).
