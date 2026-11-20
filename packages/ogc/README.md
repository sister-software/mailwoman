# @mailwoman/ogc

An [OGC API](https://ogcapi.ogc.org) adapter for the [Mailwoman](https://mailwoman.post) engine. OGC API clients
such as QGIS, GDAL/OGR and OWSLib start from a service's landing page and its conformance declaration. This
package serves both, the API definition they link to, as described in
[OGC API Common Part 1](https://docs.ogc.org/is/19-072/19-072.html), and the collections of
[OGC API Common Part 2](https://www.opengis.net/doc/is/ogcapi-common-2/1.0). Forward geocoding is served at `/search`, in the
form of the [PDOK Location API](https://api.pdok.nl/kadaster/location-api/v1/).

```sh
npx @mailwoman/ogc serve --port 8090
curl "http://localhost:8090/collections"
curl "http://localhost:8090/search?q=Dam%201%2C%201012JS%20Amsterdam&limit=2"
```

`serve` loads the same engine as `@mailwoman/photon` and `@mailwoman/nominatim`: the en-US classifier, the
gazetteer, and the address-point, interpolation and street-centroid layers under `$MAILWOMAN_DATA_ROOT`. It
exits with a message naming the missing data when no gazetteer is found. Pass `--candidate-db <path>` to choose
a candidate gazetteer.

## Endpoints

| Endpoint                      | What it returns                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `/`                           | The landing page: a title, a description and links to every resource below         |
| `/conformance`                | `{ "conformsTo": [...] }`, the conformance classes the routes implement            |
| `/api`                        | The API definition as OpenAPI 3.0 (`application/vnd.oai.openapi+json;version=3.0`) |
| `/collections`                | `{ "links": [...], "collections": [...] }`, the collections the engine serves      |
| `/collections/{collectionId}` | One collection, as `/collections` lists it, or a 404 for an unknown id             |
| `/search`                     | Forward geocoding, as a GeoJSON FeatureCollection (`application/geo+json`)         |
| `/openapi.json`               | The same routes as OpenAPI 3.1, the document every Mailwoman HTTP surface serves   |

Every resource accepts `f=json` or `f=html`. Without `f`, the `Accept` header decides, and JSON answers a
request that names neither. Any other `f` value, a query parameter the API definition doesn't name, or an
invalid value returns a 400 with the native error body, `{ "error": "invalid query parameter", "detail": "..." }`.

## Collections

A collection groups the answers one kind of layer produces. The geocoder reports which tier placed each
coordinate, and the tier decides the collection:

| Collection   | Tier                                                         | Served when                                                   |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `addresses`  | `address_point`, `interpolated`                              | a region has an address-point or interpolation layer          |
| `streets`    | `street`                                                     | a region has a street-centroid layer                          |
| `postcodes`  | `postcode`, and postcode places                              | always, because postcode places come from the gazetteer       |
| `places`     | `admin`, and the other gazetteer places the resolver weighed | always                                                        |
| `plus-codes` | `plus_code`                                                  | always, because the engine decodes plus codes without a layer |

At startup the server asks each layer provider for every region it serves and lists `addresses` and `streets`
only when some region has a layer. Their descriptions name those regions, such as `FR` or `US-TX`, and the
startup banner prints them. A region absent from the list has no layer the engine opened. Its addresses may
still exist, and the list makes no claim about them.

Each collection reports `version: 1` and `geometryDimension: 0`, since every feature is a point. `itemType`
and the `items` link are absent because the server doesn't serve `/collections/{collectionId}/items`.

## Search

| Parameter                   | Meaning                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `q`                         | The address or place to search for. Required.                                          |
| `<collectionId>[version]=1` | Restrict the search to the named collections. Repeat it for each collection.           |
| `<collectionId>[relevance]` | A number from 0 to 1. It also selects the collection, and doesn't change the ranking.  |
| `limit`                     | The most features to return, from 1 to 50. The default is 10.                          |
| `bbox`                      | `minLon,minLat,maxLon,maxLat`. Only features whose point lies inside the box are kept. |
| `f`                         | `json` (GeoJSON) or `html`.                                                            |

The response carries `timeStamp`, `links` (`self` and `alternate`) and `numberReturned` beside `features`.
Each feature's properties are:

- `display_name`: a one-line label, in the country's address order for an address or a street.
- `score`: the engine's ranking score for the match, larger ranking higher. Scores compare candidates for
  one part of the input and have no unit across collections. A match the engine measured no score for, such as
  an address point or a place without a recorded population, has `score: null`, and `score_unmeasured` names the
  reason.
- `collection_id`: the collection the feature belongs to.

The first feature is the engine's answer. The places the resolver weighed for the same part of the input
follow. A box whose minimum longitude exceeds its maximum crosses the antimeridian. `f=html` without `q`
serves a search form, which the landing page links as `search`.

### Differences from PDOK

- A `q` without a collection parameter searches every collection and returns 200. PDOK answers 400, because
  its index needs the collection. The engine has no such need.
- `<collectionId>[relevance]` is accepted so a PDOK client works unchanged, but it doesn't reweight the
  ranking, because the engine's scores don't compare across collections.
- Features carry no `href` to an item yet. The link arrives with `/collections/{collectionId}/items` in #3142.
- PDOK defines no reverse operation, so reverse geocoding stays on `@mailwoman/photon` and `@mailwoman/nominatim`.

## Conformance

The declaration lists five OGC API Common Part 1 classes, each under
`http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/`, and one Part 2 class:

- `core`: HTTP 1.1, and a 400 for an unknown query parameter or an invalid value.
- `landing-page`: the landing page links the API definition (`service-desc` and `service-doc`) and the
  conformance declaration, and each link resolves.
- `json`: the landing page, conformance declaration and collections as `application/json`.
- `html`: the same resources as HTML5, each link an `<a>` element.
- `oas30`: an OpenAPI 3.0 definition as `service-desc` and its HTML form as `service-doc`.
- `http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/collections`: the landing page links `/collections`
  as `data`, and `/collections` and each `/collections/{collectionId}` carry `self` and `alternate` links with
  a `type`.

`/search` is PDOK's convention. OGC publishes no conformance class for it, so the declaration names none.

## Link hrefs behind a proxy

Link hrefs are absolute and resolve against the request's own origin. Behind a reverse proxy that rewrites
the host or mounts the service under a path, pass the public URL:

```sh
npx @mailwoman/ogc serve --base-url https://example.org/ogc/
```

## Library use

`createOGCApp` takes an `OGCEngine`: the collections it serves and a `search(q)` that returns its matches.
`geocodeSearchHits` projects a `geocodeAddress` result to those matches.

```ts
import { serveNode } from "@mailwoman/api-kit"
import { createOGCApp, geocodeSearchHits, OGCCollectionID } from "@mailwoman/ogc"

const app = createOGCApp(
	{
		collections: [{ id: OGCCollectionID.Places, regions: null }],
		search: async (q) => geocodeSearchHits(await geocode(q)),
	},
	{ baseURL: "https://example.org/ogc/" }
)

serveNode({ fetch: app.fetch, port: 8090, hostname: "0.0.0.0" })
```

## CORS

The server sends `Access-Control-Allow-Origin: *` and answers preflight `OPTIONS` by default. Turn it off
with `--no-cors`, or `createOGCApp(engine, { cors: false })`, where a reverse proxy already sets the headers.
