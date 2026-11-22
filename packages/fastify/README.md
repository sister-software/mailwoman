# @mailwoman/fastify

A **Fastify plugin** that mounts the [Mailwoman](https://mailwoman.post) pipeline as HTTP routes. Register it and your Fastify app parses, geocodes, and answers POI queries locally — no external geocoding service.

```sh
npm i @mailwoman/fastify fastify
```

```ts
import mailwomanFastify from "@mailwoman/fastify"
import Fastify from "fastify"

const app = Fastify()
await app.register(mailwomanFastify, { prefix: "/geo", candidateDatabasePath: "/data/wof/candidate.db" })
await app.listen({ port: 8080 })
```

```sh
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

| Option                  | Type               | Purpose                                                                                                                                                         |
| ----------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline`              | `InjectedPipeline` | A pre-built parse function, such as a `createRuntimePipeline(...)` result or a test double. Supply it and the plugin loads zero weights. You own and close it.  |
| `candidateDatabasePath` | `string`           | A candidate gazetteer (`candidate.db`). With this path or the next, `geocode` goes through a geocode session.                                                   |
| `resolveDatabasePath`   | `string`           | A WOF admin database, read when no candidate gazetteer resolves.                                                                                                |
| `poiDatabasePath`       | `string`           | A `poi.db` layer. Enables `POST /v1/poi` and POI execution on the pipeline the plugin builds.                                                                   |
| `locale`                | `string`           | The locale whose weights the plugin loads and every parse and geocode runs under. Absent, the plugin loads the default weights and detects each input's locale. |
| `prefix`                | `string`           | Fastify `register` prefix for all plugin routes (e.g. `"/geo"` exposes `POST /geo/v1/parse`).                                                                   |

The plugin builds its engine on the first request and closes it when the Fastify instance closes.

- **With `candidateDatabasePath` or `resolveDatabasePath`,** the engine is the geocode session the Photon, Nominatim, OGC and MCP servers build: zero country scope from the locale, over every data layer `mailwoman geocode` composes. The layers come from the data root (`$MAILWOMAN_DATA_ROOT`), and a layer that isn't installed is left out. The session resolves a candidate gazetteer first: `candidateDatabasePath`, then `$MAILWOMAN_CANDIDATE_DB`, then the data root's. Parse and POI run a pipeline over that session's classifier and gazetteer.
- **With neither path,** the engine is a pipeline over the weights. The plugin reads zero data root. `parse` works, and `geocode` answers the parsed components with `lat` and `lon` set to `null`.
- **With `pipeline`,** all three operations read your function, and the gazetteer paths are ignored.

## Decorator

The plugin adds a `fastify.mailwoman` decorator exposing the same three operations programmatically:

```ts
const parsed = await app.mailwoman.parse("350 5th Ave, New York, NY 10118")
const geo = await app.mailwoman.geocode("350 5th Ave, New York, NY 10118")
const poi = await app.mailwoman.poi("coffee near Union Square") // throws if poiDatabasePath is unset
```

`geocode(text, options?)` takes a geocode session's request options:

| Request option   | Type                                      | Effect                                                                       |
| ---------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `inputMode`      | `"auto"`, `"formatted"` or `"fragmented"` | The register the parse reads the input in.                                   |
| `bias`           | `Array<{ lat, lon, weight? }>`            | Points the resolver prefers candidates near.                                 |
| `parentPlace`    | `{ id, source, strength }`                | A parent place that scopes every lookup of this input.                       |
| `defaultCountry` | ISO 3166-1 country code                   | A country the caller restricts this one input to. The next call is unscoped. |

```ts
const paris = await app.mailwoman.geocode("Paris", { defaultCountry: "US" })
```

A call states zero locale. The locale is the `locale` registration option, so two locales take two registrations under two prefixes. `parse` and `poi` take the pipeline's per-call options without `locale`.

## License

AGPL-3.0-only OR LicenseRef-Commercial — see the [mailwoman repository](https://github.com/sister-software/mailwoman).
