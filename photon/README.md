# @mailwoman/photon

A **Photon-compatible autocomplete geocoding API** over the [Mailwoman](https://mailwoman.sister.software) engine — search-as-you-type, returning GeoJSON `FeatureCollection`s. Where [`@mailwoman/nominatim`](../nominatim) is structured lookup, this is the type-ahead front door. No Elasticsearch.

```bash
# One-time data fetch (worldwide candidate gazetteer, ~1.4 GB):
mkdir -p "${MAILWOMAN_DATA_ROOT:-/tmp/mailwoman-data}/wof"
curl -fSL https://public.sister.software/mailwoman/gazetteer/2026-07-07a/candidate.db \
  -o "${MAILWOMAN_DATA_ROOT:-/tmp/mailwoman-data}/wof/candidate.db"

MAILWOMAN_DATA_ROOT="${MAILWOMAN_DATA_ROOT:-/tmp/mailwoman-data}" \
  npx @mailwoman/photon serve --port 2322
# or point at your own data: --candidate-db <path> / $MAILWOMAN_CANDIDATE_DB
```

Prefer to try before self-hosting? A hosted trial endpoint runs at
**https://photon.sister.software** (`/api` + `/reverse`, conservative rate limits).

```bash
curl "http://localhost:2322/api?q=1600 penn&limit=5&lat=38.9&lon=-77"
curl "http://localhost:2322/reverse?lat=38.8977&lon=-77.0365"
```

## Endpoints

| Endpoint        | Photon contract                                      |
| --------------- | ---------------------------------------------------- |
| `/api`          | forward / autocomplete → GeoJSON FeatureCollection   |
| `/reverse`      | `lat`/`lon` → GeoJSON FeatureCollection              |
| `/openapi.json` | emitted OpenAPI 3.1 document for `/api` + `/reverse` |

Backed by Mailwoman's FST autocomplete tier (#190/#587) + parse → resolve.

## Library use

```ts
import { serveNode } from "@mailwoman/api-kit"
import { createPhotonApp, type PhotonEngine } from "@mailwoman/photon"

const engine: PhotonEngine = {/* search, reverse — backed by your Mailwoman pipeline */}
const app = createPhotonApp(engine)
serveNode({ fetch: app.fetch, port: 2322, hostname: "0.0.0.0" })
```

## CORS

Map widgets (`leaflet-control-geocoder`, `@openrunner/photon-geocoder`) call this cross-origin from the browser, so the server sends permissive CORS by default — `Access-Control-Allow-Origin: *` and a `204` answer to preflight `OPTIONS`, matching upstream Photon. Behind a reverse proxy that already sets the headers, turn it off with `--no-cors` (or `createPhotonApp(engine, { cors: false })`).

## Status

Shipped. `/api` and `/reverse` resolve over the live engine and return Photon GeoJSON. `/api` runs the
query through the geocoder today; the dedicated prefix-first FST front (the last bit of Photon's tuned
type-ahead ordering) is a refinement. Pairs with [`@mailwoman/nominatim`](../nominatim) for the
structured-lookup shape and the OpenCage-style annotations block.
