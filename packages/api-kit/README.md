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

## OpenAPI

`attachOpenAPIDocs` mounts a document endpoint (default `/openapi.json`) that's always derived from the
app's route table — never handwritten. It serves OpenAPI 3.1. Need the 3.0.3 flavor too (client generators
that lag behind 3.1)? `emitOpenAPIDocuments(app, info)` returns both `{ v31, v30 }` from the same route
table, for build artifacts or parity tests.
