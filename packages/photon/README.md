# @mailwoman/photon

A **Photon-compatible autocomplete geocoding API** over the [Mailwoman](https://mailwoman.ai) engine — search-as-you-type, returning GeoJSON `FeatureCollection`s. Where [`@mailwoman/nominatim`](../nominatim) is structured lookup, this is the type-ahead front door. No Elasticsearch.

```bash
# One-time data fetch (worldwide candidate gazetteer, population-first ranking, ~1.65 GB):
MAILWOMAN_DATA_ROOT="${MAILWOMAN_DATA_ROOT:-/tmp/mailwoman-data}" npx mailwoman data pull candidate

MAILWOMAN_DATA_ROOT="${MAILWOMAN_DATA_ROOT:-/tmp/mailwoman-data}" \
  npx @mailwoman/photon serve --port 2322
# The pulled candidate.db is auto-detected at $MAILWOMAN_DATA_ROOT/db/wof/candidate.db — no export needed.
# Or point at your own data: --candidate-db <path> / $MAILWOMAN_CANDIDATE_DB
```

Prefer to try before self-hosting? A hosted trial endpoint runs at
**https://photon.mailwoman.ai** (`/api` + `/reverse`, conservative rate limits).

```bash
curl "http://localhost:2322/api?q=1600 penn&limit=5&lat=38.9&lon=-77"
curl "http://localhost:2322/reverse?lat=38.8977&lon=-77.0365"
```

## Endpoints

| Endpoint        | Photon interface                                     |
| --------------- | ---------------------------------------------------- |
| `/`             | HTML landing page (endpoint index + example queries) |
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

## Coordinate provenance and the OpenStreetMap credit

A primary feature whose coordinate came from an address-point or interpolation register names that
row in a `mailwoman` property, verbatim. A row from an OpenStreetMap layer also includes the credit, so a
client that draws an attribution control can show it:

```jsonc
{
	"mailwoman": {
		"coordinate_source": { "source": "openstreetmap:nz", "release": "2026-08-06" },
		"attribution": "© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright",
	},
}
```

`serve` opens the OpenStreetMap address-point layers an operator built under
`$MAILWOMAN_DATA_ROOT/db/osm/` when `@mailwoman/osm` is installed. A feature from any other register
has that register's stamp and no `attribution`, and a deployment without an OpenStreetMap layer
serves no OpenStreetMap data and never emits either. The OpenStreetMap Foundation's Geocoding Guideline
asks a public geocoder serving its data for a service-level credit, so a public deployment with a layer
attached also states "© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright"
in its own documentation or map attribution. `format=jsonld` includes neither field. See the
[HTTP APIs reference](https://mailwoman.ai/docs/developers/reference/http-apis#coordinate-provenance-and-the-openstreetmap-credit).

## Status

Shipped. `/api` and `/reverse` resolve over the live engine and return Photon GeoJSON. `/api` runs the
query through the geocoder today. The dedicated prefix-first FST front (the last bit of Photon's tuned
type-ahead ordering) is a refinement. Pairs with [`@mailwoman/nominatim`](../nominatim) for the
structured-lookup shape and the OpenCage-style annotations block.
