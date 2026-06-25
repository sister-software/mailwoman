# @mailwoman/photon

A **Photon-compatible autocomplete geocoding API** over the [Mailwoman](https://mailwoman.sister.software) engine — search-as-you-type, returning GeoJSON `FeatureCollection`s. Where [`@mailwoman/nominatim`](../nominatim) is structured lookup, this is the type-ahead front door. No Elasticsearch.

```bash
npx @mailwoman/photon serve --port 2322 --data <gazetteer-or-bundle>
```

```bash
curl "http://localhost:2322/api?q=1600 penn&limit=5&lat=38.9&lon=-77"
curl "http://localhost:2322/reverse?lat=38.8977&lon=-77.0365"
```

## Endpoints

| Endpoint   | Photon contract                                    |
| ---------- | -------------------------------------------------- |
| `/api`     | forward / autocomplete → GeoJSON FeatureCollection |
| `/reverse` | `lat`/`lon` → GeoJSON FeatureCollection            |

Backed by Mailwoman's FST autocomplete tier (#190/#587) + parse → resolve.

## Library use

```ts
import express from "express"
import { createPhotonRouter, type PhotonEngine } from "@mailwoman/photon"

const engine: PhotonEngine = {
	/* search, reverse — backed by your Mailwoman pipeline */
}
express().use(createPhotonRouter(engine)).listen(2322)
```

## Status

**Scaffold** (epic [#801](https://github.com/sister-software/mailwoman/issues/801)). Router, parameter
parsing, and the Photon GeoJSON types are in place; the engine wiring (FST autocomplete + reverse) is
the next step. Pairs with [`@mailwoman/nominatim`](../nominatim) for the structured-lookup shape.
