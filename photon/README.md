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

## CORS

Map widgets (`leaflet-control-geocoder`, `@openrunner/photon-geocoder`) call this cross-origin from the browser, so the server sends permissive CORS by default — `Access-Control-Allow-Origin: *` and a `204` answer to preflight `OPTIONS`, matching upstream Photon. Behind a reverse proxy that already sets the headers, turn it off with `--no-cors` (or `createPhotonRouter(engine, { cors: false })`).

## Status

Shipped. `/api` and `/reverse` resolve over the live engine and return Photon GeoJSON. `/api` runs the
query through the geocoder today; the dedicated prefix-first FST front (the last bit of Photon's tuned
type-ahead ordering) is a refinement. Pairs with [`@mailwoman/nominatim`](../nominatim) for the
structured-lookup shape and the OpenCage-style annotations block.
