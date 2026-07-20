# @mailwoman/fastify

A **Fastify plugin** that mounts the [Mailwoman](https://mailwoman.sister.software) pipeline as HTTP routes. Register it and your Fastify app parses, geocodes, and answers POI queries locally — no external geocoding service.

```bash
npm i @mailwoman/fastify fastify
```

```ts
import Fastify from "fastify"
import mailwomanFastify from "@mailwoman/fastify"

const app = Fastify()
await app.register(mailwomanFastify, { resolveDatabasePath: "/data/candidate.db" })
await app.listen({ port: 8080 })
```

```bash
curl -sX POST localhost:8080/geocode -H content-type:application/json -d '{"text":"350 5th Ave, New York, NY 10118"}'
```

## Routes

| Route           | Body       | Returns                                                                             |
| --------------- | ---------- | ----------------------------------------------------------------------------------- |
| `POST /parse`   | `{ text }` | Ordered `components` + the decoded `tree`                                           |
| `POST /geocode` | `{ text }` | A `GeocodeResult` (coordinate, resolution tier, admin hierarchy, ranked candidates) |
| `POST /poi`     | `{ text }` | The POI intent / results (`501` when no `poiDatabasePath` is configured)            |
| `GET /health`   | —          | `{ ok, version }`                                                                   |

A missing or blank `text` answers `400 { error: "text is required" }`; the POI route without a configured database answers `501 { error, detail }`. The error envelope matches `@mailwoman/api`'s native `/v1` surface.

## Options

| Option                | Type              | Purpose                                                                                                            |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pipeline`            | `RuntimePipeline` | A pre-built pipeline (`createRuntimePipeline(...)`). The DI / testing path — supply it and no weights are loaded.  |
| `resolveDatabasePath` | `string`          | WOF gazetteer (`candidate.db` / `wof.db`) for the lazily-built resolver. Omit → parse works, geocode has no coord. |
| `poiDatabasePath`     | `string`          | A `poi.db` layer. Enables `POST /poi`; wires POI execution on the lazily-built pipeline.                           |
| `locale`              | `string`          | Locale for the lazily-loaded weights + default per-call hint. Defaults to `"en-US"`.                               |
| `routePrefix`         | `string`          | Prefix every route (e.g. `"/geo"` → `POST /geo/parse`). Defaults to `""`.                                          |

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
