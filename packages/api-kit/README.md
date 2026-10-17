# @mailwoman/api-kit

This package provides [Mailwoman](https://mailwoman.ai)'s HTTP plumbing: a node `serve` wrapper and
OpenAPI emit helpers shared by the drop-in packages ([`@mailwoman/libpostal`](../libpostal),
[`@mailwoman/photon`](../photon), [`@mailwoman/nominatim`](../nominatim)).

**The package supplies shared HTTP helpers.** Domain schemas, routes, and wire interfaces live with the package that owns them, so this package has no `ParseRequestSchema` or `/parse` handler.

```ts
import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs, serveNode } from "@mailwoman/api-kit"

const app = new OpenAPIHono()
// ...register routes with app.openapi(...)...

attachOpenAPIDocs(app, { title: "my-api", version: "1.0.0" })
serveNode({ fetch: app.fetch, port: 8081, hostname: "0.0.0.0" })
```

`serveNode` is the one place a node HTTP listener gets created — surface packages stay web-standard
(`fetch`-shaped apps only), so deploying one to an edge runtime needs no changes to it.

## Canonicalize ahead of the validators

zod-openapi's auto-validators never produce wire output. A handler canonicalizes a POST body down to
its string-typed contract fields and dedupes a repeated GET parameter before validation, so
validation cannot fail. Every wire decision lives in the handler, and the schemas drive only the
emitted document. The one boundary is a legacy surface that did emit validation errors, such as
Photon's numeric parameters: there a failure maps to the vendor-shaped envelope. Photon's error
envelope is a FeatureCollection plus `message`, never `{error}`.

The drop-ins share four adjudications. An empty parameter coalesces the raw value and then trims it.
A non-string body field and a duplicate parameter are never part of the contract. A JSON-parseable
body is honored under any content type. A body over 100 KiB answers 413 through `bodyLimit`. Photon,
Nominatim and libpostal make the same calls, because an inconsistency across the surfaces costs more
than either choice.

## OpenAPI

`attachOpenAPIDocs` mounts a document endpoint (default `/openapi.json`) that's always derived from the
app's route table — never handwritten. It serves OpenAPI 3.1. Need the 3.0.3 flavor too (client generators
that lag behind 3.1)? `emitOpenAPIDocuments(app, info)` returns both `{ v31, v30 }` from the same route
table, for build artifacts or parity tests.
