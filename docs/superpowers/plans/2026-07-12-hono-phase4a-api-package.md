# Hono API surface, Phase 4a: api-kit enrichment + the `@mailwoman/api` native package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich api-kit (generic metrics, native error envelope, full-info OpenAPI documents that pass redocly's default ruleset) and ship the new `@mailwoman/api` workspace — the engine-agnostic native surface (`/v1/parse`, `/v1/geocode`, `/v1/batch`, `/v1/resolve`, `/v1/format`, `/health`, `/metrics`) — WITHOUT touching any consumer. Phase 4b does the `mailwoman serve` cutover, `mailwoman/server` deletion, and RemoteResolver repoint.

**Architecture:** Two structural decisions correct the original spec sketch, both dependency-driven:

1. **Metrics genericize into api-kit.** `mailwoman/server/metrics.ts` imports `ResolutionTier` from `mailwoman` — porting verbatim would invert the dependency arrow. api-kit gets a dependency-free, string-keyed port (`recordTimed(ms, tier)`, `metricsSnapshot()`, same reservoir/percentile math); `@mailwoman/api` supplies the tier names.
2. **`@mailwoman/api` is engine-agnostic**, like the three drop-ins: `createMailwomanAPI(engine: MailwomanAPIEngine)` — no dependency on the `mailwoman` package (which would cycle when `mailwoman serve` mounts this app in 4b). Its only workspace deps: `@mailwoman/api-kit`, `@mailwoman/formatter` (the `/v1/format` endpoint calls it directly — the design's original motivation), `@mailwoman/core` (types only: `SerializedSolution`, `AddressTree`).

The native surface is OURS (no vendor constraint): fresh `/v1/*` paths per the approved spec, camelCase JSON fields for new shapes, the api-kit error envelope everywhere, wire shapes for `/v1/geocode`//`/v1/batch`//`/v1/resolve` carried from the express `GeocodeRouter` (their bodies are consumed by RemoteResolver + existing automation; keep them stable across the 4b repoint — same `GeocodeResult` passthrough, same `{ results: [...] }` batch envelope, same `{ tree }` resolve envelope, same 400/413/503 semantics).

**Tech Stack:** hono `^4.12.29`, `@hono/zod-openapi` `^1.4.0`, zod `^4.4.3`, vitest. Exemplars on main: `photon/{routes,app}.ts`, `nominatim/{routes,app}.ts`, `api-kit/*`.

## Global Constraints

- **5-point new-workspace registration** (phase-1 Critical — memory `project-hono-api-phase1`): root `package.json` workspaces array, root `tsconfig.json` references, `.release-it.json` workspaces list, `scripts/smoke-clean-install.ts` (`WORKSPACES` + `IMPORT_CHECK`), root `vitest.config.ts` alias. Receipt = `yarn compile && node scripts/smoke-clean-install.ts`.
- **Do not touch consumers**: `mailwoman/server/*`, `mailwoman/commands/serve.tsx`, `resolver/remote-resolver.ts`, and all their tests stay EXACTLY as they are — phase 4b owns them. The express server keeps working on main throughout 4a.
- api-kit stays plumbing-only: the generic metrics module and the error envelope are plumbing (no domain knowledge); the full-info doc options are plumbing. Domain schemas (`/v1/*` shapes) live in `@mailwoman/api`.
- Emitted-document quality gate (NEW this phase): `emitOpenAPIDocuments` output for `@mailwoman/api` must pass `npx --yes @redocly/cli@latest lint` with zero errors (the old handwritten yamls did; the drop-ins currently don't — they get re-stamped in 4b using the same enriched options).
- `erasableSyntaxOnly`; `.ts` imports; acronym casing (`createMailwomanAPI`, `MailwomanAPIEngine`, `attachOpenAPIDocs`); both exports maps on the new package; lockfile deltas commit with their change; compile before `out/`; oxfmt before commit; vitest one `--dir` per invocation; kill only exact `$!` PIDs.
- Two carry-forward micro-fixes ride Task 1 (same files, trivial): the `__proto__` docstring backtick fix in `photon/routes.ts` + `nominatim/routes.ts` (oxfmt's JSDoc pass mangled `__proto__` into bold markers — wrap it in backticks in both files identically), and the LonLat spec strike — an ANNOTATED edit to `docs/superpowers/specs/2026-07-12-hono-api-surface-design.md` (strike `LonLat` from the api-kit atoms list with a dated parenthetical: zero consumers across three surfaces; per the anti-meta guardrail, it returns only with its first consumer).

---

### Task 1: api-kit — generic metrics, error envelope, full-info documents (+ two micro-fixes)

**Files:**

- Create: `api-kit/metrics.ts`, `api-kit/metrics.test.ts`
- Create: `api-kit/error.ts`
- Modify: `api-kit/openapi.ts`, `api-kit/index.ts`, `api-kit/index.test.ts`
- Modify (micro-fixes): `photon/routes.ts`, `nominatim/routes.ts` (one docstring line each), `docs/superpowers/specs/2026-07-12-hono-api-surface-design.md` (annotated strike)

**Interfaces:**

- Produces (Task 3 + phase 4b consume):
  - `recordTimed(latencyMs: number, tier: string): void`, `metricsSnapshot(): MetricsSnapshot`, `resetMetricsForTest(): void` — the `mailwoman/server/metrics.ts` reservoir/percentile logic ported verbatim EXCEPT: `tierCounts` becomes `Record<string, number>` (created null-prototype, keys created on first use), `"error"` stays the reserved error key, and the snapshot's `geocode` block is renamed `timings` (generic). `MetricsSnapshot = { uptime_s: number; timings: { total: number; errors: number; tiers: Record<string, number>; latency_ms: { p50; p90; p99; max } | null; latency_samples: number } }`.
  - `APIErrorSchema` (in `error.ts`) — the native envelope: `z.object({ error: z.string(), detail: z.string().optional() }).openapi("APIError")` — and `apiError(c: Context, status: ContentfulStatusCode, error: string, detail?: string)` helper returning `c.json(...)`.
  - `OpenAPIDocInfo` grows OPTIONAL fields (existing callers unaffected): `description?`, `summary?`, `license?: { name: string; identifier?: string }`, `contact?: { name?: string; url?: string }`, `externalDocs?: { description?: string; url: string }`, `servers?: Array<{ url: string; description?: string; variables?: Record<string, { default: string; description?: string }> }>`, `tags?: Array<{ name: string; description?: string }>`, `security?: unknown[]`. `attachOpenAPIDocs`/`emitOpenAPIDocuments` map them into the document config (info-block fields under `info`, the rest top-level; keep the `as never` boundary casts).

- [ ] **Step 1: Failing tests.** `api-kit/metrics.test.ts` ports the assertions from `mailwoman/server/metrics.test.ts` (read it) onto the generic names — record across two tiers + an error, snapshot percentiles over a known latency set, reset. Add to `api-kit/index.test.ts`: a doc-enrichment test — `emitOpenAPIDocuments(app, { title, version, servers: [{ url: "http://localhost" }], security: [], license: { name: "AGPL-3.0-only" }, tags: [{ name: "meta" }] })` → the v31 document carries `servers`, `security`, `info.license.name`, `tags`.
- [ ] **Step 2:** RED run (`yarn vitest run --dir ./api-kit`), implement `metrics.ts` (ported logic per the Produces contract), `error.ts`, and the `openapi.ts` extension; re-export both new modules from `index.ts`; GREEN (expect 7 prior + new all passing).
- [ ] **Step 3: Micro-fixes.** In `photon/routes.ts` + `nominatim/routes.ts`, the `legacyQuery` docstring line containing the mangled `?**proto**=` becomes ``a repeated `?__proto__=` param must create an own property``; verify `yarn oxfmt` does NOT re-mangle (backticks protect it) — if it does, rephrase to "a repeated dunder-proto param". Spec strike per Global Constraints. Run `yarn vitest run --dir ./photon` and `--dir ./nominatim` (comment-only changes; suites stay green).
- [ ] **Step 4:** `yarn compile`; `yarn oxfmt api-kit photon nominatim docs/superpowers/specs`; commit `feat(api-kit): generic timing metrics, native error envelope, full-info OpenAPI documents`.

---

### Task 2: Scaffold `@mailwoman/api` (5-point registration) + engine contract + schemas

**Files:**

- Create: `api/package.json`, `api/tsconfig.json`, `api/index.ts`, `api/engine.ts`, `api/schema.ts`
- Modify: root `package.json`, root `tsconfig.json`, `.release-it.json`, `scripts/smoke-clean-install.ts`, root `vitest.config.ts`

**Interfaces:**

- Produces:
  - Workspace `@mailwoman/api` (version `5.10.1`, dual exports maps, files `out/**` + README, publishConfig access public — mirror `api-kit/package.json` exactly, adding deps: `@hono/zod-openapi`, `@mailwoman/api-kit`, `@mailwoman/core` (workspace:_), `@mailwoman/formatter` (workspace:_), `hono`, `zod`).
  - `api/engine.ts` — the engine contract (all methods optional; absent → 501, drop-in convention):

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The native-surface engine contract. Engine-agnostic like the drop-ins: the `mailwoman` CLI
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

- `api/schema.ts` — zod wire schemas: `ParseRequestSchema` (`{ address: z.string(), debug: z.boolean().optional() }`), `ParseOutcomeSchema` (loose mirror), `GeocodeRequestSchema` (`{ address: z.string() }`), `GeocodeOutcomeSchema` (`z.looseObject({})`), `BatchRequestSchema` (`{ addresses: z.array(z.string()) }`), `BatchResponseSchema`, `ResolveRequestSchema` (`{ tree: z.looseObject({ roots: z.array(z.unknown()) }), opts: z.looseObject({}).optional() }`), `ResolveResponseSchema`, `FormatRequestSchema` (`{ components: z.record(z.string(), z.union([z.string(), z.array(z.string())])), country: z.string(), options: z.looseObject({}).optional() }`), `FormatResponseSchema` (`{ formatted: z.string(), canonicalKey: z.string() }`), `HealthResponseSchema` (loose), re-export `APIErrorSchema` usage from api-kit (import, don't redefine). This surface is ours: bodies are REQUIRED and validator-enforced (no legacy tolerance to preserve) — validation failures map through a `defaultHook` to the api-kit envelope (`apiError(c, 400, "invalid request body", <zod summary>)`). This is the documented pattern boundary from phase 2: where no legacy contract exists, the validator MAY speak, but only in our envelope.

- [ ] Steps: package.json + tsconfig (mirror api-kit + core/formatter refs + `resolveJsonModule`/`files` for the self-referencing import) → ALL FIVE registration points → `yarn install` → `engine.ts`/`schema.ts` → placeholder `index.ts` re-exports → `yarn compile` → `node scripts/smoke-clean-install.ts` (expect pass with the new package packed) → oxfmt → commit `feat(api): scaffold @mailwoman/api — engine contract + wire schemas (5-point registration)`.

---

### Task 3: `@mailwoman/api` routes + app + tests

**Files:**

- Create: `api/routes.ts`, `api/app.ts`, `api/index.test.ts`, `api/README.md`
- Modify: `api/index.ts`

**Interfaces:**

- Produces: `createMailwomanAPI(engine: MailwomanAPIEngine, options?: MailwomanAPIOptions): OpenAPIHono` where `MailwomanAPIOptions = { cors?: boolean; bodyLimitBytes?: number }` (cors default true; bodyLimit default 2 MiB — carried from the express `express.json({ limit: "2mb" })`); `registerMailwomanAPIRoutes(app, engine)`.

Route/wire contract:

- `POST /v1/parse` (body `ParseRequestSchema`) + `GET /v1/parse?address=&debug=` — 200 `ParseOutcomeSchema`; 400 envelope `"address is required"` when absent/empty (GET reads via `legacyQuery`-style first-value; this surface accepts simple single params, no tolerance theater — use `c.req.query()` directly); 501 when `engine.parse` absent.
- `POST /v1/geocode` — 200 GeocodeOutcome passthrough; 400 `"address is required"`; 503 envelope `"geocoder not available"` when `engine.geocode` absent (NOTE: 503 not 501 — carried from express `DEPS_UNAVAILABLE` semantics: the engine method is expected in production; absence means deps missing). Metrics: wrap with `recordTimed` from api-kit, tier from `outcome["resolution_tier"] ?? "admin"`, `"error"` on throw (rethrow into the 500 net after recording).
- `POST /v1/batch` — 200 `{ results }`; 400 `"body must be { addresses: string[] }"`; empty array → 200 `{ results: [] }`; 413 envelope when `addresses.length > batchMax` (`MailwomanAPIOptions` gains `batchMax?: number` default 500 — carried from `$public.MAILWOMAN_BATCH_MAX`'s default; the CLI passes the env-derived value in 4b); 503 when absent. Per-row metrics recorded by the ENGINE in 4b (the app records only whole-call latency here — note in the docstring).
- `POST /v1/resolve` — 200 `{ tree }`; 400 `"body must be { tree: AddressTree, opts? }"`; 503 when absent. (RemoteResolver's target after 4b.)
- `POST /v1/reload` — 200 `{ reloaded, versions }` passthrough; 503 when `engine.reload` absent (deploy-only endpoint, gate at ingress — carried note from express).
- `POST /v1/format` — wired IN-PACKAGE: validate body, call `formatAddress(components, country, options)` + `canonicalKey(components)` from `@mailwoman/formatter`, 200 `{ formatted, canonicalKey }`; 400 envelope on validation failure. No engine method — always available.
- `GET /health` — 200: `{ status: "ok", uptime_s, ...engine.health?.() ?? {} }` (engine block spread in; absent engine → still 200 with status+uptime — health must answer even when broken, carried from express).
- `GET /metrics` — 200 api-kit `metricsSnapshot()`.
- `app.onError` → 500 envelope `"internal error"` (+ `detail` carrying `err.message` — ours, so we can be helpful).
- CORS default on (`GET, POST, OPTIONS`); `attachOpenAPIDocs` with FULL info: title/version from the self-referencing package.json, license `{ name: "AGPL-3.0-only OR LicenseRef-Commercial", identifier: "AGPL-3.0-only" }`, contact Sister Software + https://mailwoman.sister.software, servers `[{ url: "http://{host}:{port}", variables: { host: { default: "127.0.0.1" }, port: { default: "3000" } } }]`, `security: []`, tags.

- [ ] Steps (TDD): write `api/index.test.ts` first — fixture engines pinning: every endpoint's happy path; 400/413/501/503 envelopes with exact bodies; format round-trip (`{ components: { house_number: "1600", road: "Pennsylvania Ave NW", city: "Washington" }, country: "US" }` → formatted string contains "1600" and canonicalKey is non-empty — do NOT pin the full formatted string, the formatter template owns it); health-with/without-engine; metrics endpoint reflects a recorded geocode; validation failure → envelope not zod-shape; `/openapi.json` has all 8 paths; **redocly gate**: emit the v31 document to a temp file (scratchpad) and `npx --yes @redocly/cli@latest lint <file>` → zero errors (execute via node child_process in the test? NO — keep it a Task-5-style manual receipt: run it as a step, not a test). RED → implement `routes.ts`/`app.ts` → GREEN → compile → oxfmt → README (short, factual: engine contract, endpoints table, serveNode snippet WITH hostname) → commit `feat(api): the native /v1 surface — parse, geocode, batch, resolve, format, health, metrics`.
- [ ] Final step: the redocly receipt — boot nothing; `node -e` emit the document to the scratchpad, lint it, capture output in the report. Zero errors required (this is the Global-Constraints gate).

---

### Task 4: Repo-wide green + branch wrap

- [ ] `rm -rf api/out api-kit/out && yarn compile`; `yarn vitest run --dir ./api`; `--dir ./api-kit`; `--dir ./photon`; `--dir ./nominatim`; `yarn test:integration`; `node scripts/smoke-clean-install.ts`; `yarn lint:oxlint`; `yarn oxfmt --check api api-kit`.
- [ ] Push `feat/hono-api-package`; PR: spec/plan links; the two architecture corrections (metrics genericization — dependency arrow; engine-agnostic api — reference-cycle avoidance) called out explicitly as spec deviations for the record; wire-shape carryover table (geocode/batch/resolve bodies stable for the 4b repoint); redocly zero-error receipt; 5-point registration receipt; no consumers touched (express server still running on main); phase-4b scope note. Attribution line.
- Controller runs the final whole-branch review, then merges under the standing grant.
