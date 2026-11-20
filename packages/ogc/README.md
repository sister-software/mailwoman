# @mailwoman/ogc

An [OGC API](https://ogcapi.ogc.org) adapter for the [Mailwoman](https://mailwoman.post) engine. OGC API clients
such as QGIS, GDAL/OGR and OWSLib start from a service's landing page and its conformance declaration. This
package serves both, and the API definition they link to, as described in
[OGC API Common Part 1](https://docs.ogc.org/is/19-072/19-072.html).

```sh
npx @mailwoman/ogc serve --port 8090
curl "http://localhost:8090/?f=json"
curl "http://localhost:8090/conformance"
```

The resources this stage serves read no gazetteer, so `serve` needs no data root.

## Endpoints

| Endpoint        | What it returns                                                                    |
| --------------- | ---------------------------------------------------------------------------------- |
| `/`             | The landing page: a title, a description and links to every resource below         |
| `/conformance`  | `{ "conformsTo": [...] }`, the conformance classes the routes implement            |
| `/api`          | The API definition as OpenAPI 3.0 (`application/vnd.oai.openapi+json;version=3.0`) |
| `/openapi.json` | The same routes as OpenAPI 3.1, the document every Mailwoman HTTP surface serves   |

Every resource accepts `f=json` or `f=html`. Without `f`, the `Accept` header decides, and JSON answers a
request that names neither. Any other `f` value, or a query parameter the API definition doesn't name,
returns a 400 with the native error body, `{ "error": "invalid query parameter", "detail": "..." }`.

## Conformance

The declaration lists five OGC API Common Part 1 classes, each under
`http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/`:

- `core`: HTTP 1.1, and a 400 for an unknown query parameter or an invalid value.
- `landing-page`: the landing page links the API definition (`service-desc` and `service-doc`) and the
  conformance declaration, and each link resolves.
- `json`: the landing page and conformance declaration as `application/json`.
- `html`: the same two resources as HTML5, each link an `<a>` element.
- `oas30`: an OpenAPI 3.0 definition as `service-desc` and its HTML form as `service-doc`.

The landing page carries no `data` link yet, because `/collections` doesn't exist. Collections and forward
geocoding through `/search` follow in #3141, and OGC API Features items in #3142. Each one adds its
conformance class when its route lands.

## Link hrefs behind a proxy

Link hrefs are absolute and resolve against the request's own origin. Behind a reverse proxy that rewrites
the host or mounts the service under a path, pass the public URL:

```sh
npx @mailwoman/ogc serve --base-url https://example.org/ogc/
```

## Library use

```ts
import { serveNode } from "@mailwoman/api-kit"
import { createOGCApp } from "@mailwoman/ogc"

const app = createOGCApp({ baseURL: "https://example.org/ogc/" })
serveNode({ fetch: app.fetch, port: 8090, hostname: "0.0.0.0" })
```

## CORS

The server sends `Access-Control-Allow-Origin: *` and answers preflight `OPTIONS` by default. Turn it off
with `--no-cors`, or `createOGCApp({ cors: false })`, where a reverse proxy already sets the headers.
