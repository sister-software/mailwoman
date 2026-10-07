# @mailwoman/fastify

A **Fastify plugin** that mounts the [Mailwoman](https://mailwoman.ai) pipeline as HTTP routes. Register it and your Fastify app parses, geocodes, and answers POI queries locally — no external geocoding service.

```bash
npm i @mailwoman/fastify fastify
```

```ts
import mailwomanFastify from "@mailwoman/fastify"
import Fastify from "fastify"

const app = Fastify()
await app.register(mailwomanFastify, { prefix: "/geo", resolveDatabasePath: "/data/candidate.db" })
await app.listen({ port: 8080 })
```

```bash
curl -sX POST localhost:8080/geo/v1/geocode -H content-type:application/json -d '{"address":"350 5th Ave, New York, NY 10118"}'
```

## Routes

Every route is a shared `@mailwoman/api` operation, so the request and response schemas match the native `/v1` surface.

| Route              | Body                       | Returns                                                                             |
| ------------------ | -------------------------- | ----------------------------------------------------------------------------------- |
| `POST /v1/parse`   | `{ address, input_mode? }` | The `@mailwoman/api` parse response (`debug` is `null`)                             |
| `GET /v1/parse`    | `?address=`                | Same as `POST /v1/parse`                                                            |
| `POST /v1/geocode` | `{ address, input_mode? }` | A `GeocodeResult` (coordinate, resolution tier, admin hierarchy, ranked candidates) |
| `POST /v1/poi`     | `{ query }`                | The POI intent and results (`501` when no `poiDatabasePath` is configured)          |
| `GET /health`      | —                          | `{ status, uptime_s, version }`                                                     |

A missing or blank `address` or `query` answers `400 { error, detail }`; the POI route without a configured database answers `501 { error, detail }`. The error envelope matches `@mailwoman/api`'s native `/v1` surface.

## Options

| Option                | Type              | Purpose                                                                                                            |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pipeline`            | `RuntimePipeline` | A pre-built pipeline (`createRuntimePipeline(...)`). The DI / testing path — supply it and no weights are loaded.  |
| `resolveDatabasePath` | `string`          | WOF gazetteer (`candidate.db` / `wof.db`) for the lazily-built resolver. Omit → parse works, geocode has no coord. |
| `poiDatabasePath`     | `string`          | A `poi.db` layer. Enables `POST /v1/poi`; wires POI execution on the lazily-built pipeline.                        |
| `locale`              | `string`          | Locale for the lazily-loaded weights + default per-call hint. Defaults to `"en-US"`.                               |
| `prefix`              | `string`          | Fastify `register` prefix for all plugin routes (e.g. `"/geo"` exposes `POST /geo/v1/parse`).                      |

Supply `pipeline` to inject your own pipeline; otherwise the plugin builds one lazily on the first request. Weights and gazetteer data resolve through `@mailwoman/neural`'s standard resolution — the same lookup the CLI and the drop-in servers use.

## Decorator

The plugin adds a `fastify.mailwoman` decorator exposing the same three operations programmatically:

```ts
const parsed = await app.mailwoman.parse("350 5th Ave, New York, NY 10118")
const geo = await app.mailwoman.geocode("350 5th Ave, New York, NY 10118")
const poi = await app.mailwoman.poi("coffee near Union Square") // throws if poiDatabasePath is unset
```

## License

AGPL-3.0-only OR LicenseRef-Commercial — see the [mailwoman repository](https://github.com/sister-software/mailwoman).
