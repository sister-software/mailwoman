# @mailwoman/api-kit

Plumbing for [Mailwoman](https://mailwoman.sister.software)'s HTTP surfaces — a node `serve` wrapper and
OpenAPI emit helpers shared by the drop-in packages ([`@mailwoman/libpostal`](../libpostal),
[`@mailwoman/photon`](../photon), [`@mailwoman/nominatim`](../nominatim)).

**Plumbing only.** Domain schemas, routes, and wire contracts live with the package that owns them — this
package never grows a `ParseRequestSchema` or a `/parse` handler of its own.

```ts
import { attachOpenAPIDocs, serveNode } from "@mailwoman/api-kit"
import { OpenAPIHono } from "@hono/zod-openapi"

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
