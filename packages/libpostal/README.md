# @mailwoman/libpostal

A **libpostal-compatible** parse/expand HTTP API over [Mailwoman](https://mailwoman.ai)'s
neural address parser. It is the drop-in API with the fewest dependencies, because `/parse` needs only the
model and no gazetteer.

```bash
npx @mailwoman/libpostal serve --port 8081
```

```bash
curl -s "http://localhost:8081/parse?query=1600 Pennsylvania Ave NW, Washington DC 20500"
# [{"label":"house_number","value":"1600"},{"label":"road","value":"Pennsylvania Ave NW"},
#  {"label":"city","value":"Washington"},{"label":"state","value":"DC"},{"label":"postcode","value":"20500"}]
```

## Endpoints

| Endpoint        | libpostal interface                                         |
| --------------- | ----------------------------------------------------------- |
| `/`             | HTML landing page (endpoint index + example queries)        |
| `/parse`        | `parse_address` — ordered `[{label, value}]` components     |
| `/expand`       | `expand_address` — normalized forms (see the note below)    |
| `/openapi.json` | the emitted OpenAPI 3.1 document, served as the spec itself |

`/parse` maps Mailwoman's `ComponentTag` classifications to libpostal's labels (`street`→`road`,
`locality`→`city`, `region`→`state`, …) through `COMPONENT_TO_LIBPOSTAL`. Both `/parse` and
`/expand` accept `GET` (query string) or `POST` (JSON body). The server parses the JSON body
natively, so you do not need to mount middleware.

**Note on `/expand`:** Mailwoman's normalization is deterministic, so `/expand` returns the
original plus its normalized and abbreviation-expanded forms. It does not reproduce libpostal's
probabilistic multi-variant expansion, and it returns one canonical alternative instead of a set
of hypotheses.

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

`createLibpostalApp` returns a plain `fetch`-shaped Hono app. You can deploy it behind any
web-standard runtime (edge, Workers, Deno). `serveNode` is only the Node listener wrapper.

## CORS

Browser clients call this server cross-origin, including the preflighted `POST /parse`, so the server sends permissive CORS headers by default. It sets `Access-Control-Allow-Origin: *` and answers a preflight `OPTIONS` with `204`. Behind a reverse proxy that already sets the headers, turn CORS off with `--no-cors` (or `createLibpostalApp(engine, { cors: false })`).
