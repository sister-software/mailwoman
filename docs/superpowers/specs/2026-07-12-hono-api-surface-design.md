# Schema-first API surface on Hono — design

**Date:** 2026-07-12
**Status:** Approved (operator, 2026-07-12)
**Supersedes:** `mailwoman/server/` (express, Pelias-debug-page descendant), the handwritten OpenAPI 3.1 yamls (#1054), and the `feat/api-clients` branch (abandoned unmerged).

## Problem

Three defects share one root cause:

1. `mailwoman/server/` is an express relic, redundant with the Docusaurus demo pages.
2. The drop-in packages (`photon/`, `nominatim/`, `libpostal/`) each cram wire types, mapping, and an express Router into a single 200–490-line `index.ts`, with a **handwritten** `openapi.yaml` beside it that nothing ties to the code.
3. `feat/api-clients` vendors ~9.9k lines of generated Python client source plus hand-downgraded 3.0 spec copies for Rust's progenitor — three spec copies per API, zero enforcement that any matches the running server.

Root cause: the spec is written downstream of the code, and clients are vendored downstream of the spec. Every hop is a manually maintained copy.

### The isp-nexus lesson

`@isp.nexus/schema` tried code-first schema derivation and drowned — not because code-first was wrong, but because it required **owning a compiler**: a 1,633-line bespoke TS→JSON-schema generator whose feature coverage had to grow with every TypeScript construct used, emitting `generated/*.json` as a second source of truth. The failure mode to avoid is _generator ownership_ and _artifact round-tripping_, not code-first itself. Zod 4's native `z.toJSONSchema()` and route-level OpenAPI emitters make the generator a library call.

## Decisions (settled 2026-07-12)

| Question  | Decision                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope     | The 3 vendor drop-ins **and** a new first-party native API. One stack, four surfaces.                                                                                                                                              |
| Framework | **Hono + `@hono/zod-openapi`** (Zod 4). Web-standard primitives; node via `@hono/node-server`; edge stays open. Fastify rejected (node-only); tRPC rejected (owns its wire format — cannot reproduce fixed vendor REST contracts). |
| Clients   | Spec is the artifact. Python (PyPI) + Rust (crates.io, progenitor) regenerate from the emitted spec in the release workflow. No generated source in the repo.                                                                      |
| Topology  | New `@mailwoman/api-kit` (plumbing) + new `@mailwoman/api` (native surface). Drop-ins keep their workspaces. `mailwoman/server/` deleted.                                                                                          |
| Legacy    | **Vendor wire compatibility is the only binding constraint.** No deprecation shims for the express `Router` exports; internal/consumer churn is acceptable.                                                                        |

## Architecture

Code-first, one direction:

```
Zod schemas (next to routes) ──> Hono route table ──> emitted OpenAPI (3.1 + 3.0) ──> CI-generated clients
        │                              │
        └── z.infer static types       └── request validation + typed handlers
```

- Each schema is declared **next to the route it validates, in the package that owns that wire contract**. No central schema package.
- `createRoute({ method, path, request, responses })` binds schema, handler, and OpenAPI metadata in one object.
- Each surface is a Hono sub-app behind an engine interface — the existing `createPhotonRouter(engine)` pattern carried over as `createPhotonApp(engine)`. Engine interfaces are unchanged; engine implementers are untouched.
- The OpenAPI document is emitted from the route table — never handwritten — in 3.1 and 3.0 flavors. 3.0 exists solely for generator compatibility (progenitor); it kills `downgrade-spec.py`.
- Artifacts never flow backward. Nothing generated is imported by source.

### Anti-meta discipline (the isp-nexus guardrails)

1. Schemas live next to routes. A schema with no route in the same package is a smell.
2. Only true wire atoms are shared (lon/lat, bbox, GeoJSON envelopes, locale param, error envelope) — they live in `api-kit`, which is **forbidden from holding domain schemas**.
3. No generator code in the repo. If deriving an artifact requires more than a library call and a script invocation, the design has failed.

## Components

### `@mailwoman/api-kit` (new workspace)

Plumbing only:

- `serve()` — `@hono/node-server` wrapper with the house flags (port, host, graceful shutdown).
- Error-envelope middleware + the native error schema.
- Spec-emit helper: route table → 3.1/3.0 documents, plus a mounted `/openapi.json` endpoint.
- Shared wire atoms: ~~`LonLat`~~ (2026-07-12: struck — zero consumers across three surfaces; returns with its
  first consumer per the anti-meta guardrail), `BBox`, GeoJSON `Feature`/`FeatureCollection` envelopes, locale
  param.
- Metrics hooks ported from `mailwoman/server/metrics.ts` (its test moves too).

### Drop-ins: `photon/`, `nominatim/`, `libpostal/`

Each single-file `index.ts` splits into:

| File        | Contents                                                                        |
| ----------- | ------------------------------------------------------------------------------- |
| `schema.ts` | Zod wire schemas — exact legacy key names (snake_case, vendor vocab, immutable) |
| `routes.ts` | `createRoute` definitions + handlers                                            |
| `engine.ts` | Engine interface — **unchanged**                                                |
| `app.ts`    | `create<Surface>App(engine)` sub-app factory                                    |
| `cli.ts`    | `serve` command, same flags as today                                            |
| `index.ts`  | Re-exports                                                                      |

Express dependency dropped. Routes whose engine method is absent still answer `501` (staged-implementation convention preserved).

### `@mailwoman/api` (new workspace)

The native surface, `mailwoman/server/`'s successor:

- `POST/GET /v1/parse` — runtime pipeline parse.
- ~~`POST/GET /v1/geocode`~~ **(2026-07-12 amendment, Task 3 of the 4b cutover plan):** implemented `POST /v1/geocode` — POST-only, parse + resolve.
- ~~`POST/GET /v1/resolve`~~ **(2026-07-12 amendment, Task 3):** implemented `POST /v1/resolve` — POST-only, resolve a component dict.
- `POST /v1/format` — `@mailwoman/formatter` called directly (`formatAddress` / `canonicalKey`).
- `GET /health`.
- **(2026-07-12 amendment, Task 3 — not in the original sketch):** `POST /v1/batch` — batch geocode over an `addresses` array, rows trimmed, bounded by `$public.MAILWOMAN_BATCH_CONCURRENCY`/`MAILWOMAN_BATCH_MAX`.
- **(2026-07-12 amendment, Task 3 — not in the original sketch):** `POST /v1/reload` — reload the shard provider.
- **(2026-07-12 amendment, Task 3 — not in the original sketch):** `GET /metrics` — api-kit request-timing metrics.

Native responses use the api-kit error envelope and camelCase field conventions — this surface is ours; vendor constraints do not apply.

### `mailwoman serve`

~~Mounts all four sub-apps at prefixes (`/photon`, `/nominatim`, `/libpostal`, `/` native).~~ **(2026-07-12 amendment, Task 3 of the 4b cutover plan):** this doesn't ship as designed. The drop-in packages depend on `mailwoman` (their CLIs wire engines from `mailwoman/geocode-core`), so `mailwoman serve` importing `createPhotonApp`/`createNominatimApp`/`createLibpostalApp` would create a dependency cycle. `mailwoman serve` therefore serves the **native `/v1` surface only**. Every surface app and its engine wiring stays exportable, so a unified process (all four mounted together) is a compose-your-own script the operator writes against those exports — documented as an example, not shipped as a command. Per-package `npx @mailwoman/<x> serve` CLIs remain the deployment story.

### Clients + release workflow

- `clients/` from `feat/api-clients` never merges. Salvage: `clients/README.md` + `PUBLISHING.md` notes.
- Release workflow gains a client-generation job: emit specs → generate Python (`openapi-python-client`) + Rust (progenitor build over emitted 3.0) → publish PyPI/crates.io. Generated source is never committed.

## Data flow

Request → Zod-coerced query/body validation → engine call → mapping (`ComponentTag` → surface vocab) → typed response → wire.

Response schemas validate in dev/test; production is pass-through (the per-keystroke Photon autocomplete path stays cheap).

## Error handling

- Drop-ins: **exact legacy error wire shapes**, including validation-failure bodies. Zod failures map per-surface, not globally.
- Native: uniform api-kit error envelope.

## Testing

- Hono apps test via `app.request()` — no listener; existing suites (`photon/index.test.ts` 371 lines, `nominatim/` 189, `libpostal/` 98) port directly.
- **Spec-parity gate (one-time):** golden test comparing each emitted spec against the handwritten redocly-validated yamls. Each difference is adjudicated — either a bug in the new routes or a bug that was always in the yaml. After adjudication the yamls are deleted.
- CLI smoke tests run against compiled `out/cli.js` (compile before test — stale `out/` lies).
- Both exports maps (dev `node → .ts` + `publishConfig`) updated for every new subpath, per repo convention.

## Order

1. `@mailwoman/api-kit` — plumbing + atoms.
2. `libpostal/` — smallest drop-in (198 lines) proves the pattern end-to-end, spec-parity gate included.
3. `photon/`, then `nominatim/`.
4. `@mailwoman/api` — native surface.
5. Delete `mailwoman/server/` + express deps repo-wide; `mailwoman serve` rewires.
6. Release-workflow client job.
7. Delete the handwritten yamls; abandon `feat/api-clients`.

## Versioning + ops

- Express `Router` export removal and `mailwoman/server` deletion ride the next-major train, alongside the `core/formatter` removal (PR #1074) and the #875 casing batch. No shims — vendor wire compat is the only legacy binding.
- The hosted photon systemd unit (`mailwoman-photon.service`) redeploys after merge, post-POSAIS per standing plan.

## Out of scope

- Edge/Workers deployment (kept possible, not built).
- TS client packaging (Hono RPC types come free with the sub-apps; publishing a dedicated TS client is a later decision).
- Any change to engine implementations or the parse/resolve pipeline.
