# Hono API surface, Phase 4a: api-kit enrichment + the `@mailwoman/api` native package — Implementation Plan

> **For agentic workers:** required sub-skill: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich api-kit with generic metrics, a native error envelope, and full-info OpenAPI documents that pass redocly's default ruleset. Ship the new `@mailwoman/api` workspace, the engine-agnostic native surface (`/v1/parse`, `/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/format`, `/health`, `/metrics`). Do not touch any consumer. Phase 4b does the `mailwoman serve` cutover, deletes `mailwoman/server`, and repoints RemoteResolver.

**Architecture:** Two structural decisions correct the original spec sketch. Both follow from the dependency graph:

1. **Metrics become generic and move into api-kit.** `mailwoman/server/metrics.ts` imports `ResolutionTier` from `mailwoman`, so porting it verbatim would invert the dependency direction. api-kit gets a dependency-free, string-keyed port (`recordTimed(ms, tier)`, `metricsSnapshot()`, with the same reservoir and percentile math), and `@mailwoman/api` supplies the tier names.
2. **`@mailwoman/api` is engine-agnostic**, like the three drop-ins: `createMailwomanAPI(engine: MailwomanAPIEngine)`. It does not depend on the `mailwoman` package, because that dependency would form a cycle when `mailwoman serve` mounts this app in 4b. Its only workspace dependencies are `@mailwoman/api-kit`, `@mailwoman/formatter` (the `/v1/format` endpoint calls it directly, which was the design's original motivation), and `@mailwoman/core` (types only: `SerializedSolution`, `AddressTree`).

We own the native surface, so no vendor interface constrains it. It uses fresh `/v1/*` paths per the approved spec, camelCase JSON fields for new shapes, and the api-kit error envelope everywhere. The wire shapes for `/v1/geocode`, `/v1/batch`, and `/v1/resolve` carry over from the express `GeocodeRouter`, because RemoteResolver and existing automation consume their bodies. Keep them stable across the 4b repoint: the same `GeocodeResult` passthrough, the same `{ results: [...] }` batch envelope, the same `{ tree }` resolve envelope, and the same 400/413/503 semantics.

**Tech Stack:** hono `^4.12.29`, `@hono/zod-openapi` `^1.4.0`, zod `^4.4.3`, vitest. Exemplars on main: `photon/{routes,app}.ts`, `nominatim/{routes,app}.ts`, `api-kit/*`.

## Global Constraints

- **Register a new workspace in five places** (a phase-1 Critical finding, see memory `project-hono-api-phase1`): the root `package.json` workspaces array, root `tsconfig.json` references, the `.release-it.json` workspaces list, `scripts/smoke-clean-install.ts` (`WORKSPACES` + `IMPORT_CHECK`), and the root `vitest.config.ts` alias. The receipt is `yarn compile && node scripts/smoke-clean-install.ts`.
- **Do not touch consumers.** `mailwoman/server/*`, `mailwoman/commands/serve.tsx`, `resolver/remote-resolver.ts`, and all their tests stay exactly as they are, because phase 4b owns them. The express server keeps working on main throughout 4a.
- api-kit stays plumbing-only. The generic metrics module, the error envelope, and the full-info doc options carry no domain knowledge, so they belong there. Domain schemas (the `/v1/*` shapes) live in `@mailwoman/api`.
- Emitted-document quality check (new this phase): The `emitOpenAPIDocuments` output for `@mailwoman/api` must pass `npx --yes @redocly/cli@latest lint` with zero errors. The old handwritten yamls passed. The drop-ins currently do not, and 4b regenerates them with the same enriched options.
- House rules: `erasableSyntaxOnly`, `.ts` imports, acronym casing (`createMailwomanAPI`, `MailwomanAPIEngine`, `attachOpenAPIDocs`), both exports maps on the new package, lockfile changes committed with the change that caused them, compile before reading `out/`, oxfmt before commit, one vitest `--dir` per invocation, and kill only exact `$!` PIDs.
- Task 1 also carries two small fixes in the same files:
  - The `__proto__` docstring backtick fix in `photon/routes.ts` and `nominatim/routes.ts`. oxfmt's JSDoc pass turned `__proto__` into bold markers. Wrap it in backticks identically in both files.
  - The LonLat spec strike, an annotated edit to `docs/superpowers/specs/2026-07-12-hono-api-surface-design.md`. Strike `LonLat` from the api-kit atoms list and add a dated parenthetical saying it has zero consumers across three surfaces. Per the anti-meta guardrail, it comes back only with its first consumer.

---

### Task 1: api-kit — generic metrics, error envelope, full-info documents (+ two micro-fixes)

**Files:**

- Create: `api-kit/metrics.ts`, `api-kit/metrics.test.ts`
- Create: `api-kit/error.ts`
- Modify: `api-kit/openapi.ts`, `api-kit/index.ts`, `api-kit/index.test.ts`
- Modify (micro-fixes): `photon/routes.ts`, `nominatim/routes.ts` (one docstring line each), `docs/superpowers/specs/2026-07-12-hono-api-surface-design.md` (annotated strike)

**Interfaces:**

- Produces (Task 3 + phase 4b consume):
  - `recordTimed(latencyMs: number, tier: string): void`, `metricsSnapshot(): MetricsSnapshot`, `resetMetricsForTest(): void`. These port the `mailwoman/server/metrics.ts` reservoir and percentile logic verbatim, with three exceptions: `tierCounts` becomes `Record<string, number>` (created with a null prototype, with keys added on first use), `"error"` stays the reserved error key, and the snapshot's `geocode` block is renamed to the generic `timings`. `MetricsSnapshot = { uptime_s: number; timings: { total: number; errors: number; tiers: Record<string, number>; latency_ms: { p50; p90; p99; max } | null; latency_samples: number } }`.
  - `APIErrorSchema` (in `error.ts`) — the native envelope: `z.object({ error: z.string(), detail: z.string().optional() }).openapi("APIError")` — and `apiError(c: Context, status: ContentfulStatusCode, error: string, detail?: string)` helper returning `c.json(...)`.
  - `OpenAPIDocInfo` grows OPTIONAL fields (existing callers unaffected): `description?`, `summary?`, `license?: { name: string; identifier?: string }`, `contact?: { name?: string; url?: string }`, `externalDocs?: { description?: string; url: string }`, `servers?: Array<{ url: string; description?: string; variables?: Record<string, { default: string; description?: string }> }>`, `tags?: Array<{ name: string; description?: string }>`, `security?: unknown[]`. `attachOpenAPIDocs`/`emitOpenAPIDocuments` map them into the document config (info-block fields under `info`, the rest top-level; keep the `as never` boundary casts).

- [ ] **Step 1: Failing tests.** `api-kit/metrics.test.ts` ports the assertions from `mailwoman/server/metrics.test.ts` (read it) onto the generic names: record across two tiers and an error, check snapshot percentiles over a known latency set, and reset. Add to `api-kit/index.test.ts`: a doc-enrichment test — `emitOpenAPIDocuments(app, { title, version, servers: [{ url: "http://localhost" }], security: [], license: { name: "AGPL-3.0-only" }, tags: [{ name: "meta" }] })` → the v31 document carries `servers`, `security`, `info.license.name`, `tags`.
- [ ] **Step 2:** RED run (`yarn vitest run --dir ./api-kit`), implement `metrics.ts` (ported logic per the Produces interface), `error.ts`, and the `openapi.ts` extension; re-export both new modules from `index.ts`; GREEN (expect 7 prior + new all passing).
- [ ] **Step 3: Micro-fixes.** In `photon/routes.ts` + `nominatim/routes.ts`, the `legacyQuery` docstring line containing the mangled `?**proto**=` becomes ``a repeated `?__proto__=` param must create an own property``; verify that `yarn oxfmt` does not mangle it again (oxfmt should leave text inside backticks alone). If it does, rephrase to "a repeated dunder-proto param". Make the spec strike described in Global Constraints. Run `yarn vitest run --dir ./photon` and `--dir ./nominatim`. The changes touch only comments, so the suites should stay green.
- [ ] **Step 4:** `yarn compile`; `yarn oxfmt api-kit photon nominatim docs/superpowers/specs`; commit `feat(api-kit): generic timing metrics, native error envelope, full-info OpenAPI documents`.

---

### Task 2: Scaffold `@mailwoman/api` (5-point registration) + engine interface + schemas

**Files:**

- Create: `api/package.json`, `api/tsconfig.json`, `api/index.ts`, `api/engine.ts`, `api/schema.ts`
- Modify: root `package.json`, root `tsconfig.json`, `.release-it.json`, `scripts/smoke-clean-install.ts`, root `vitest.config.ts`

**Interfaces:**

- Produces:
  - Workspace `@mailwoman/api` (version `5.10.1`, dual exports maps, files `out/**` + README, publishConfig access public — mirror `api-kit/package.json` exactly, adding deps: `@hono/zod-openapi`, `@mailwoman/api-kit`, `@mailwoman/core` (workspace:_), `@mailwoman/formatter` (workspace:_), `hono`, `zod`).
  - `api/engine.ts` — the engine interface. Every method is optional, and an absent method returns 501, following the drop-in convention:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native-surface engine interface. Engine-agnostic like the drop-ins: the `mailwoman` CLI
 *   wires the real parse/geocode/resolve stack (phase 4b); tests inject fixtures. `format` is the
 *   exception — it's wired in-package from `@mailwoman/formatter` (the surface exists to expose it).
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { SerializedSolution } from "@mailwoman/core/solver"

/** One parse outcome: the tokenized input span + ranked solutions (the legacy /parse shape). */
export interface ParseOutcome {
	input: { body: string; start: number; end: number }
	solutions: SerializedSolution[]
	debug?: string
}

/** A geocode outcome — the engine returns the geocode-core `GeocodeResult` shape verbatim (passthrough). */
export type GeocodeOutcome = Record<string, unknown>

/** A batch row: a GeocodeOutcome, or an `{ input, error }` slot (per-row isolation). */
export type BatchRow = GeocodeOutcome | { input: string; error: string }

export interface ResolveTreeOutcome {
	tree: AddressTree
}

/** The `/health` data block the engine contributes (model card, data-root inventory). */
export type HealthData = Record<string, unknown>

export interface MailwomanAPIEngine {
	parse?(address: string, opts: { debug: boolean }): Promise<ParseOutcome>
	geocode?(address: string): Promise<GeocodeOutcome>
	batch?(addresses: string[]): Promise<{ results: BatchRow[] }>
	resolveTree?(tree: AddressTree, opts: Record<string, unknown>): Promise<ResolveTreeOutcome>
	reload?(): Promise<{ reloaded: boolean; versions: unknown }>
	health?(): HealthData
}
```

- `api/schema.ts` — zod wire schemas: `ParseRequestSchema` (`{ address: z.string(), debug: z.boolean().optional() }`), `ParseOutcomeSchema` (loose mirror), `GeocodeRequestSchema` (`{ address: z.string() }`), `GeocodeOutcomeSchema` (`z.looseObject({})`), `BatchRequestSchema` (`{ addresses: z.array(z.string()) }`), `BatchResponseSchema`, `ResolveRequestSchema` (`{ tree: z.looseObject({ roots: z.array(z.unknown()) }), opts: z.looseObject({}).optional() }`), `ResolveResponseSchema`, `FormatRequestSchema` (`{ components: z.record(z.string(), z.union([z.string(), z.array(z.string())])), country: z.string(), options: z.looseObject({}).optional() }`), `FormatResponseSchema` (`{ formatted: z.string(), canonicalKey: z.string() }`), `HealthResponseSchema` (loose), and `APIErrorSchema` imported from api-kit rather than redefined. We own this surface, so request bodies are required and enforced by the validator, and there is no legacy leniency to preserve. Validation failures map through a `defaultHook` to the api-kit envelope (`apiError(c, 400, "invalid request body", <zod summary>)`). This follows the pattern boundary documented in phase 2: where no legacy interface exists, the validator may report errors, but only in our envelope.

- [ ] Steps:
  1. Write package.json and tsconfig, mirroring api-kit, with core/formatter references and `resolveJsonModule`/`files` for the self-referencing import.
  2. Update all five registration points.
  3. Run `yarn install`.
  4. Write `engine.ts` and `schema.ts`, plus placeholder re-exports in `index.ts`.
  5. Run `yarn compile`, then `node scripts/smoke-clean-install.ts`, which should pass with the new package packed.
  6. Run oxfmt and commit `feat(api): scaffold @mailwoman/api — engine interface + wire schemas (5-point registration)`.

---

### Task 3: `@mailwoman/api` routes + app + tests

**Files:**

- Create: `api/routes.ts`, `api/app.ts`, `api/index.test.ts`, `api/README.md`
- Modify: `api/index.ts`

**Interfaces:**

- Produces: `createMailwomanAPI(engine: MailwomanAPIEngine, options?: MailwomanAPIOptions): OpenAPIHono`, where `MailwomanAPIOptions = { cors?: boolean; bodyLimitBytes?: number }`. cors defaults to true, and bodyLimit defaults to 2 MiB, carried over from the express `express.json({ limit: "2mb" })`. Also produces `registerMailwomanAPIRoutes(app, engine)`.

Route/wire interface:

- `POST /v1/parse` (body `ParseRequestSchema`) and `GET /v1/parse?address=&debug=` return 200 `ParseOutcomeSchema`. They return the 400 envelope `"address is required"` when the address is absent or empty. GET reads the first value `legacyQuery`-style. This surface accepts simple single params without extra leniency, so use `c.req.query()` directly. They return 501 when `engine.parse` is absent.
- `POST /v1/geocode` returns the GeocodeOutcome passthrough with 200, or 400 `"address is required"`. It returns the 503 envelope `"geocoder not available"` when `engine.geocode` is absent. The status is 503 rather than 501, carried over from the express `DEPS_UNAVAILABLE` semantics: production expects the engine method, so its absence means dependencies are missing. Metrics: wrap the call with `recordTimed` from api-kit, take the tier from `outcome["resolution_tier"] ?? "admin"`, and record `"error"` on a throw, then rethrow into the 500 handler.
- `POST /v1/batch` returns 200 `{ results }`, or 400 `"body must be { addresses: string[] }"`. An empty array returns 200 `{ results: [] }`. It returns the 413 envelope when `addresses.length > batchMax`. `MailwomanAPIOptions` gains `batchMax?: number`, defaulting to 500 like `$public.MAILWOMAN_BATCH_MAX`, and the CLI passes the env-derived value in 4b. It returns 503 when the engine method is absent. In 4b the engine records per-row metrics, and the app records only whole-call latency here. Note this in the docstring.
- `POST /v1/resolve` returns 200 `{ tree }`, 400 `"body must be { tree: AddressTree, opts? }"`, or 503 when the engine method is absent. RemoteResolver targets it after 4b.
- `POST /v1/reload` returns the `{ reloaded, versions }` passthrough with 200, or 503 when `engine.reload` is absent. It is a deploy-only endpoint that should be restricted at ingress, a note carried over from express.
- `POST /v1/format` is wired inside the package. It validates the body, calls `formatAddress(components, country, options)` and `canonicalKey(components)` from `@mailwoman/formatter`, and returns 200 `{ formatted, canonicalKey }`, or the 400 envelope on a validation failure. It needs no engine method, so it is always available.
- `GET /health` returns 200 with `{ status: "ok", uptime_s, ...engine.health?.() ?? {} }`, spreading in the engine block. Without an engine it still returns 200 with status and uptime, because health must answer even when the server is broken (carried over from express).
- `GET /metrics` returns 200 with api-kit `metricsSnapshot()`.
- `app.onError` returns the 500 envelope `"internal error"`, with `detail` carrying `err.message`. We own this surface, so the error can be informative.
- CORS is on by default (`GET, POST, OPTIONS`). `attachOpenAPIDocs` gets full info: title/version from the self-referencing package.json, license `{ name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" }`, contact Sister Software + https://mailwoman.ai, servers `[{ url: "http://{host}:{port}", variables: { host: { default: "127.0.0.1" }, port: { default: "3000" } } }]`, `security: []`, tags.

- [ ] Steps (TDD): Write `api/index.test.ts` first, with fixture engines that pin:
  - every endpoint's happy path
  - the 400/413/501/503 envelopes with exact bodies
  - a format round-trip: `{ components: { house_number: "1600", road: "Pennsylvania Ave NW", city: "Washington" }, country: "US" }` produces a formatted string that contains "1600" and a non-empty canonicalKey. Do not pin the full formatted string, because the formatter template owns it.
  - health with and without an engine
  - the metrics endpoint reflecting a recorded geocode
  - a validation failure returning our envelope rather than the zod shape
  - `/openapi.json` listing all 8 paths

  The **redocly check** emits the v31 document to a temp file in the scratchpad and runs `npx --yes @redocly/cli@latest lint <file>`, which must report zero errors. Do not run it through node child_process inside the test. Keep it a manual receipt in the Task 5 style, run as a step rather than a test.

  Then run the tests and see them fail, implement `routes.ts` and `app.ts`, get the tests passing, compile, and run oxfmt. Write a short, factual README covering the engine interface, an endpoints table, and a serveNode snippet with hostname. Commit `feat(api): the native /v1 surface — parse, geocode, batch, resolve, format, health, metrics`.

- [ ] Final step: the redocly receipt. Boot no server. Emit the document to the scratchpad with `node -e`, lint it, and capture the output in the report. It must report zero errors, which is the Global Constraints check.

---

### Task 4: Repo-wide green + branch wrap

- [ ] `rm -rf api/out api-kit/out && yarn compile`; `yarn vitest run --dir ./api`; `--dir ./api-kit`; `--dir ./photon`; `--dir ./nominatim`; `yarn test:integration`; `node scripts/smoke-clean-install.ts`; `yarn lint:oxlint`; `yarn oxfmt --check api api-kit`.
- [ ] Push `feat/hono-api-package` and open a PR. The PR body includes:
  - links to the spec and plan
  - the two architecture corrections, called out explicitly as spec deviations for the record: generic metrics (to keep the dependency direction) and the engine-agnostic api (to avoid a reference cycle)
  - a table of carried-over wire shapes (the geocode, batch, and resolve bodies stay stable for the 4b repoint)
  - the redocly zero-error receipt
  - the 5-point registration receipt
  - confirmation that no consumers were touched (the express server still runs on main)
  - a phase-4b scope note
  - the attribution line
- The controller runs the final whole-branch review, then merges under the standing grant.
