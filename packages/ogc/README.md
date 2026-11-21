# @mailwoman/ogc

An [OGC API](https://ogcapi.ogc.org) adapter for the [Mailwoman](https://mailwoman.post) engine. OGC API clients
such as QGIS, GDAL/OGR and OWSLib start from a service's landing page and its conformance declaration. This
package serves both, the API definition they link to, as described in
[OGC API Common Part 1](https://docs.ogc.org/is/19-072/19-072.html), and the collections of
[OGC API Common Part 2](https://www.opengis.net/doc/is/ogcapi-common-2/1.0). With `--serve-items`, the `places`
collection serves the gazetteer's places as items, as described in
[OGC API Features Part 1](https://docs.ogc.org/is/17-069r4/17-069r4.html), so QGIS, GDAL/OGR and other Features
clients can browse them. Forward geocoding is served at `/search`, in the form of the
[PDOK Location API](https://api.pdok.nl/kadaster/location-api/v1/).

```sh
npx @mailwoman/ogc serve --port 8090
curl "http://localhost:8090/collections"
curl "http://localhost:8090/search?q=Dam%201%2C%201012JS%20Amsterdam&limit=2"

# Bulk browsing is opt-in.
npx @mailwoman/ogc serve --port 8090 --serve-items
curl "http://localhost:8090/collections/places/items?bbox=4.7,52.2,5.1,52.5&limit=5"
```

`serve` loads the same engine as `@mailwoman/photon` and `@mailwoman/nominatim`: the en-US classifier, the
gazetteer, and the address-point, interpolation and street-centroid layers under `$MAILWOMAN_DATA_ROOT`. It
exits with a message naming the missing data when no gazetteer is found. Pass `--candidate-db <path>` to choose
a candidate gazetteer.

## Endpoints

| Endpoint                                        | What it returns                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/`                                             | The landing page: a title, a description and links to every resource below         |
| `/conformance`                                  | `{ "conformsTo": [...] }`, the conformance classes the routes implement            |
| `/api`                                          | The API definition as OpenAPI 3.0 (`application/vnd.oai.openapi+json;version=3.0`) |
| `/collections`                                  | `{ "links": [...], "collections": [...] }`, the collections the engine serves      |
| `/collections/{collectionId}`                   | One collection, as `/collections` lists it, or a 404 for an unknown id             |
| `/collections/{collectionId}/items`             | One page of a collection's places, as a GeoJSON FeatureCollection                  |
| `/collections/{collectionId}/items/{featureId}` | One place, as a GeoJSON Feature                                                    |
| `/search`                                       | Forward geocoding, as a GeoJSON FeatureCollection (`application/geo+json`)         |
| `/openapi.json`                                 | The same routes as OpenAPI 3.1, the document every Mailwoman HTTP surface serves   |

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
| `postcodes`  | `postcode`, and postcode places                              | the gazetteer holds postcode places                           |
| `places`     | `admin`, and the other gazetteer places the resolver weighed | always                                                        |
| `plus-codes` | `plus_code`                                                  | always, because the engine decodes plus codes without a layer |

At startup the server asks each layer provider for every region it serves and lists `addresses` and `streets`
only when some region has a layer. Their descriptions name those regions, such as `FR` or `US-TX`, and the
startup banner prints them. A region absent from the list has no layer the engine opened. Its addresses may
still exist, and the list makes no claim about them.

Each collection reports `version: 1` and `geometryDimension: 0`, since every feature is a point. A collection
that serves items adds `itemType: "feature"`, an `items` link for GeoJSON and one for HTML, and an `extent`. The other
collections carry none of the three, and their items routes answer 404.

Every collection also links where its data comes from, read from the `layer_manifest` of each database behind it:

- A `license` link ([RFC 4946](https://www.rfc-editor.org/rfc/rfc4946)) for each identifier in the recorded
  license expression whose text has a known URL: SPDX's page for an SPDX identifier, and Who's On First's own
  license text for `LicenseRef-WhosOnFirst-Mixed`, because that text requires the link back.
- A `via` link ([RFC 4287](https://www.rfc-editor.org/rfc/rfc4287), "the source of the information") for each
  source the manifest records, to the page where a user obtains it. Each source's location belongs to the package
  that builds its layers: `GAZETTEER_SOURCE_LOCATIONS` in `@mailwoman/resolver-wof-sqlite/sources` for the
  gazetteer, `BAN_SOURCE_LOCATIONS` in `@mailwoman/ban/source`, and `OSM_SOURCE_LOCATIONS` in
  `@mailwoman/osm/source`. Each build writes its source names from the same table. The Who's On First entry points to
  the [`mailwoman` organization](https://github.com/mailwoman), whose `whosonfirst-data-admin-<cc>` repositories are
  the forks the build clones from `whosonfirst-data`. The OpenStreetMap entry points to the `@mailwoman/osm` build
  documentation, because the project publishes the builder and a user builds the database.
- An `attribution`, the member OGC API Common Part 2 defines, when a recorded license requires credit.

A source that matches another opened layer, as the candidate gazetteer's manifest records the admin gazetteer,
contributes that layer's license links, sources and credit. The address and street collections read the manifest
of every region file their providers report, and list each license and source once. A manifest that records no
license or no source, a source without a known location, and a license identifier without published text add a
sentence to the description in place of a link. A region file without a readable `layer_manifest` contributes no
link, and the description counts those regions. `plus-codes` has no layer.

## Where the data comes from

The adapter serves only the operator's own data root, `$MAILWOMAN_DATA_ROOT`. `/search` answers one
query at a time. Bulk browsing through `items` is opt-in: `serve` serves no items unless it's started with
`--serve-items`.

A user who wants the data obtains it from its sources:

- The gazetteer: `mailwoman data pull candidate` installs the candidate gazetteer, as the
  [data and locales reference](https://mailwoman.post/docs/reference/data-and-locales) describes. To build the admin
  gazetteer from Who's On First yourself, clone the `whosonfirst-data-admin-<cc>` repositories from the
  [`mailwoman` organization](https://github.com/mailwoman) or from `whosonfirst-data`, then run
  `mailwoman gazetteer build admin`, as the
  [reverse geocoding guide](https://mailwoman.post/docs/guides/reverse-geocode) shows.
- Address points, interpolation and street layers: `mailwoman data pull` installs the published bundles, and the
  data and locales reference lists them.
- Each source's own terms: the [data and licensing page](https://mailwoman.post/product/data-and-licensing) links
  the publishers' pages, and each collection's `license` and `via` links state what the opened databases record.
- Your own data root: `mailwoman data inventory` lists every database under it with its license, the
  obligations that license carries, its sources and where to obtain each one, and the databases whose
  `layer_manifest` it couldn't read. The collections' links come from the same function, `resolveLayerTerms` in
  `@mailwoman/core/layers/provenance`, so the two agree.

## Items

Items are served only when `serve` is started with `--serve-items`, or `createOGCApp` is built with
`serveItems: true`. While items are off, the collection descriptions link none, both items routes answer 404
with `{ "error": "collection serves no items" }`, `/search` features carry no `href`, and `/conformance` lists
only the OGC API Common classes. The startup banner states whether items are served, and why not when they aren't.

Two collections serve items:

- `places` reads the admin gazetteer's current places, the `admin-global-priority.db` the server resolves under
  `$MAILWOMAN_DATA_ROOT/db/wof`, through its primary key and its `place_bbox` R*Tree.
- `postcodes` reads the candidate gazetteer's postcode places through its `candidate_postcode_place` index, which
  holds each postcode's id, point and name in id order. A candidate gazetteer built without that index serves no
  postcode items, and the banner says so. A server that resolves against WOF databases rather than a candidate
  gazetteer serves no postcode items either. The candidate gazetteer's recorded license decides an obligation
  refusal, as the admin gazetteer's does for `places`.

The other collections serve no items:

- `plus-codes`: the engine decodes plus codes and stores none.
- `addresses` and `streets`: out of scope for now.

| Parameter  | Meaning                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `limit`    | The most features to return. The default is 10. A value above 1000 returns 1000 rather than an error.       |
| `bbox`     | `minLon,minLat,maxLon,maxLat`, or six numbers with a minimum and maximum height after each latitude.        |
| `datetime` | An RFC 3339 date-time, or an interval of two separated by `/` with `..` or an empty string for an open end. |
| `after`    | The cursor a `next` link carries. A client follows the link rather than building it.                        |
| `f`        | `json` (GeoJSON) or `html`.                                                                                 |

A page lists places in ascending WOF id order. Its `next` link continues after the page's last id, so a deep page
costs what the first page costs, and following the links visits every place in the box once. A `postcodes` box
page walks the index in id order and keeps the postcodes whose point lies inside the box. A box with few postcodes
therefore reads more of the index before its page fills. On the 2026-11-21 candidate gazetteer, a box with no
postcodes read the whole index of 4,098,848 rows in 246 ms. The last page has no
`next` link. A response carries `timeStamp`, `numberReturned`, `self`, `alternate` and `collection` links, and
omits the optional `numberMatched`, because counting a large box's places costs a scan.

`bbox` keeps the places whose point lies inside the box, and a box whose minimum longitude exceeds its maximum
crosses the antimeridian. The places have no height, so a six-number box selects by its longitudes and latitudes.
The places carry no time either, so every valid `datetime` selects every place, as Requirement 26 C of the
standard requires for features without a temporal geometry. A malformed value of either returns 400.

A feature's `id` is the gazetteer place ID `/search` reports as `place_id`, such as `wof:101751893`, and
`/collections/places/items/wof:101751893` returns that place. Its properties are `name`, `placetype`,
`country_code` and `display_name`, the label `/search` gives the same place. An id the collection doesn't hold
returns 404.

The items routes serve the gazetteer in bulk, so with `--serve-items` the server reads the database's recorded
license at startup and prints it. When `MAILWOMAN_REFUSE_OBLIGATIONS` refuses a class that license carries, `places`
serves no items and the banner states the refusal. The database records `LicenseRef-WhosOnFirst-Mixed`
(attribution and share-alike) beside `ODbL-1.0` and `CC-BY-4.0`. An operator who sets
`MAILWOMAN_REFUSE_OBLIGATIONS=share-alike` therefore serves no items, and one who sets `unresolved` serves them.

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
- `place_id` and `placetype`: the gazetteer place ID, such as `wof:85975673`, and placetype, such as `locality`
  or `localadmin`, of a place or postcode. Two places that share a label, such as a locality and the
  local-government area of the same name, differ here. Both are absent for an address, a street and a plus code,
  and `place_id` is absent for a place the gazetteer gave no ID.
- `href`: the place's URL under `/collections/places/items`, as on PDOK. It's present only when the collection
  serves items and holds the place, so the link never answers 404.

A place's `display_name` is its name, then the ancestors the gazetteer records between it and its country, most
specific first, then the country, such as `Camden, Ouachita, Arkansas, United States`. An ancestor that repeats
the place's name appears once. A place without a WOF place ID, or without a recorded ancestry, keeps its name and
country.

The first feature is the engine's answer. The places the resolver weighed for the same part of the input
follow. A box whose minimum longitude exceeds its maximum crosses the antimeridian. `f=html` without `q`
serves a search form, which the landing page links as `search`.

### Differences from PDOK

- A `q` without a collection parameter searches every collection and returns 200. PDOK answers 400, because
  its index needs the collection. The engine has no such need.
- `<collectionId>[relevance]` is accepted so a PDOK client works unchanged, but it doesn't reweight the
  ranking, because the engine's scores don't compare across collections.
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

When a collection serves items, it adds four OGC API Features Part 1 classes, each under
`http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/`:

- `core`: the two items routes with `limit`, `bbox` and `datetime`, `next` links, and the error codes above.
- `geojson`: both items routes as `application/geo+json`.
- `html`: both items routes as HTML5, each link an `<a>` element.
- `oas30`: the OpenAPI 3.0 definition declares both items routes and their parameters in the form the standard gives.

A server whose collections serve no items declares none of the four and registers no items routes.
`/search` is PDOK's convention. OGC publishes no conformance class for it, so the declaration lists none.

## The OGC test suite

`packages/ogc/tools/ets.run.ts` runs OGC's executable test suite for Features Part 1,
[`ets-ogcapi-features10`](https://github.com/opengeospatial/ets-ogcapi-features10) revision 1.9, against a server on
this machine. It needs Podman and the data root's gazetteer. From the repository root:

```sh
node packages/ogc/tools/ets.run.ts --out "$MAILWOMAN_DATA_ROOT/audits/ogc-ets/latest"
```

The tool starts `mailwoman-ogc serve --serve-items` on 127.0.0.1 (port 8195 unless `--port` says otherwise),
because the suite needs a feature collection to test. It runs the suite
from OGC's published image `docker.io/ogccite/ets-ogcapi-features10:1.9-teamengine-6.0.0-RC2` with the host's
network, and stops the server it started. The container opens no port. The TestNG and EARL reports land under
`--out`, `summary.json` beside them lists every failed and skipped test, and the tool exits 1 when a test failed.
`--iut <url>` tests a running server instead, and the tool starts no server of its own.

## Link hrefs behind a proxy

Link hrefs are absolute and resolve against the request's own origin. Behind a reverse proxy that rewrites
the host or mounts the service under a path, pass the public URL:

```sh
npx @mailwoman/ogc serve --base-url https://example.org/ogc/
```

## Library use

`createOGCApp` takes an `OGCEngine`: the collections it serves and a `search(q)` that returns its matches.
`geocodeSearchHits` projects a `geocodeAddress` result to those matches. A collection serves items when it carries
an `items` source, such as `placeItemSource(new WOFPlaceBrowser({ databasePath }), ancestorsOf)`, with
`WOFPlaceBrowser` from `@mailwoman/resolver-wof-sqlite/browse`, and the app is built with `serveItems: true`.
A collection's `layers` lists the manifest terms its license and `via` links come from.

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
