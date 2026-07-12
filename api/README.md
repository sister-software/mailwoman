# @mailwoman/api

The **native [Mailwoman](https://mailwoman.sister.software) HTTP API** — an engine-agnostic `/v1` surface
(parse, geocode, batch, resolve, format) plus health, metrics, and an emitted OpenAPI document. Unlike its
drop-in siblings ([`@mailwoman/nominatim`](../nominatim), [`@mailwoman/photon`](../photon),
[`@mailwoman/libpostal`](../libpostal)), nothing here mimics a third-party API — this is Mailwoman's own
wire contract, so request bodies are strict and validator-enforced.

## Engine contract

The package takes a `MailwomanAPIEngine` — every method optional. An absent method answers `501` (`/v1/parse`)
or `503` (`/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/reload` — deps missing in production). `format` is
the one exception: it's wired in-package from [`@mailwoman/formatter`](../formatter) and always available,
with no engine method at all.

```ts
import type { MailwomanAPIEngine } from "@mailwoman/api"

const engine: MailwomanAPIEngine = {
	parse: async (address, opts) => {
		/* → { input, solutions, debug? } */
	},
	geocode: async (address) => {
		/* → GeocodeResult, passed through verbatim */
	},
	batch: async (addresses) => {
		/* → { results } — one row per address, in order, per-row error isolation */
	},
	resolveTree: async (tree, opts) => {
		/* → { tree } — the same tree, decorated with gazetteer coords + attribution */
	},
	reload: async () => {
		/* → { reloaded, versions } — versioned data switchover */
	},
	health: () => {
		/* → model card / data-root inventory, spread into GET /health */
	},
}
```

The `mailwoman` CLI wires the real parse/geocode/resolve stack (phase 4b); tests inject fixtures.

## Endpoints

| Endpoint        | Method    | Body / query                           | Absent-engine status       |
| --------------- | --------- | -------------------------------------- | -------------------------- |
| `/v1/parse`     | GET, POST | `{ address, debug? }` (or `?address=`) | `501`                      |
| `/v1/geocode`   | POST      | `{ address }`                          | `503`                      |
| `/v1/batch`     | POST      | `{ addresses: string[] }`              | `503`                      |
| `/v1/resolve`   | POST      | `{ tree: AddressTree, opts? }`         | `503`                      |
| `/v1/reload`    | POST      | —                                      | `503`                      |
| `/v1/format`    | POST      | `{ components, country, options? }`    | always available           |
| `/health`       | GET       | —                                      | `200` (status+uptime only) |
| `/metrics`      | GET       | —                                      | always available           |
| `/openapi.json` | GET       | —                                      | always available           |

Every error response is the native envelope: `{ error: string, detail?: string }`. A validation failure on
a strict body (e.g. `/v1/format` with no `components`) maps through the same envelope — `{ error: "invalid
request body", detail: "<short zod summary>" }` — never the raw zod shape.

## Library use

```ts
import { serveNode } from "@mailwoman/api-kit"
import { createMailwomanAPI, type MailwomanAPIEngine } from "@mailwoman/api"

const engine: MailwomanAPIEngine = {
	/* parse, geocode, batch, resolveTree, reload, health — backed by your Mailwoman pipeline */
}
const app = createMailwomanAPI(engine)
serveNode({ fetch: app.fetch, port: 3000, hostname: "0.0.0.0" })
```

## Options

`createMailwomanAPI(engine, options?)`:

- `cors` — permissive CORS (`Access-Control-Allow-Origin: *`, `GET, POST, OPTIONS`) on by default; browser
  clients (the demo, a map widget) need it for the mutating `/v1/*` preflight. Set `false` when a reverse
  proxy already owns the CORS headers.
- `bodyLimitBytes` — max request body size, enforced ahead of every `/v1/*` handler. Default 2 MiB (carried
  from the express server's `express.json({ limit: "2mb" })`). Oversized bodies answer `413` before the body
  is buffered into memory.
- `batchMax` — max `addresses` rows accepted by `POST /v1/batch`. Default 500. Exceeding it answers `413`.

## Metrics

`POST /v1/geocode` records timing to [`@mailwoman/api-kit`](../api-kit)'s generic in-process metrics —
`GET /metrics` returns the live snapshot (latency percentiles, per-tier counts). The tier is read from
`outcome["resolution_tier"]` (falling back to `"admin"`); a thrown engine error records the reserved
`"error"` tier before rethrowing into the `500` safety net. `POST /v1/batch` records only whole-call
latency here — per-row metrics are the engine's responsibility.

## Status

Phase 4a: the routes, app, and OpenAPI document ship engine-agnostic, with fixture-backed tests. Phase 4b
wires the real engine into the `mailwoman serve` CLI and repoints `RemoteResolver` at `/v1/resolve`.
