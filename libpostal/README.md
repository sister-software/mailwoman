# @mailwoman/libpostal

A **libpostal-compatible** parse/expand HTTP API over [Mailwoman](https://mailwoman.sister.software)'s
neural address parser. The lowest-dependency drop-in — `/parse` needs no gazetteer, just the model.

```bash
npx @mailwoman/libpostal serve --port 8081
```

```bash
curl -s "http://localhost:8081/parse?query=1600 Pennsylvania Ave NW, Washington DC 20500"
# [{"label":"house_number","value":"1600"},{"label":"road","value":"Pennsylvania Ave NW"},
#  {"label":"city","value":"Washington"},{"label":"state","value":"DC"},{"label":"postcode","value":"20500"}]
```

## Endpoints

| Endpoint        | libpostal contract                                             |
| --------------- | -------------------------------------------------------------- |
| `/parse`        | `parse_address` — ordered `[{label, value}]` components        |
| `/expand`       | `expand_address` — normalized forms (see the honest note)      |
| `/openapi.json` | the emitted OpenAPI 3.1 document — the spec, not a copy of one |

`/parse` maps Mailwoman's `ComponentTag` classifications to libpostal's labels (`street`→`road`,
`locality`→`city`, `region`→`state`, …) via `COMPONENT_TO_LIBPOSTAL`. Both `/parse` and `/expand`
accept `GET` (query string) or `POST` (JSON body) — the JSON body is parsed natively, no middleware
to mount.

**Honest note on `/expand`:** Mailwoman's normalization is deterministic, so `/expand` returns the
original plus its normalized + abbreviation-expanded forms — not libpostal's probabilistic multi-variant
expansion. One canonical alternative, not a hypothesis set.

## Library use

```ts
import { serveNode } from "@mailwoman/api-kit"
import { createLibpostalApp, type LibpostalEngine } from "@mailwoman/libpostal"

const engine: LibpostalEngine = {
	async parse(query) {
		/* return [{ classification, value }] from your parser */
	},
}
const app = createLibpostalApp(engine)

serveNode({ fetch: app.fetch, port: 8081, hostname: "0.0.0.0" })
```

`createLibpostalApp` returns a plain `fetch`-shaped Hono app — deploy it behind any web-standard
runtime (edge, Workers, Deno); `serveNode` is only the Node listener wrapper.

## CORS

Browser clients call this cross-origin — including the preflighted `POST /parse` — so the server sends permissive CORS by default: `Access-Control-Allow-Origin: *` and a `204` answer to preflight `OPTIONS`. Behind a reverse proxy that already sets the headers, turn it off with `--no-cors` (or `createLibpostalApp(engine, { cors: false })`).
