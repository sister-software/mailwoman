# Hono API surface, Phase 2: api-kit geo atoms + photon migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the GeoJSON wire atoms in `@mailwoman/api-kit` (first consumer) and migrate `@mailwoman/photon` from express to Hono + `@hono/zod-openapi` with the OpenAPI document emitted from the route table, retiring `photon/openapi.yaml` through the same parity gate as phase 1.

**Architecture:** Per the approved spec (`docs/superpowers/specs/2026-07-12-hono-api-surface-design.md`) and the phase-1 pattern — with one deliberate divergence. Photon is GET-only and its query params include _contractual_ repeatable params (`osm_tag`, `layer`) and numeric params whose degenerate handling is observable wire behavior (`/reverse` 400s on repeated `lat` because express hands `Number()` an array). So phase 1's canonicalize middlewares are NOT copied. Instead: a `legacyQuery(c)` adapter reproduces express's `req.query` shape exactly, the original parsing helpers move verbatim, and the query schemas are validator-proof unions with doc-exact `.openapi()` overrides — validation still cannot fail, wire decisions still live in handlers, but nothing is rewritten between the wire and the legacy parsing code. This is the "map the boundary, don't cargo-cult" line the phase-1 final review drew.

**Tech Stack:** hono `^4.12.29`, `@hono/zod-openapi` `^1.4.0`, `@mailwoman/api-kit` (phase 1: `serveNode`, `attachOpenAPIDocs`, `emitOpenAPIDocuments`), zod `^4.4.3`, vitest.

## Global Constraints

- **Vendor wire shapes are immutable.** Photon's error/degenerate envelope is an empty FeatureCollection plus message: `{"type":"FeatureCollection","features":[],"message":"…"}` — never `{error}`. Exact messages: `"q is required"`, `"lat and lon are required"`, `"lat must be in [-90, 90] and lon in [-180, 180]"`, `"internal error"`, `"search not implemented"`, `"reverse not implemented"`. Statuses 200/400/500/501. CORS methods list is `GET, OPTIONS` (no POST — differs from libpostal).
- **Repeatable params are contract**: `osm_tag` and `layer` accept repeated values (arrays). Do NOT dedup them, and do NOT copy phase 1's `canonicalizeQueryParams`/`canonicalizeJSONBody` — photon has no POST surface and its duplicate-param behavior is observable (see the `legacyQuery` adapter).
- **Engine and projection exports move verbatim** — public API, zero signature changes: `PhotonEngine`, `PhotonSearchParams`, `PhotonReverseParams`, `PhotonProperties`, `PhotonFeature`, `PhotonFeatureCollection`, `PhotonForwardInput`, `PhotonForwardResult`, `photonFeature`, `photonCollection`, `photonOSMTags`, `photonForwardProperties`, `photonForwardFeature`, `photonForwardCollection`, `photonFeatureToSchemaOrg`, `photonToSchemaOrg`, `DEFAULT_LIMIT` behavior (15). `createPhotonRouter`/`PhotonRouterOptions` are deleted, no shim (operator decision, phase 1 precedent).
- **Adjudication consistency with phase 1** (ledger + memory): same calls for the same questions; where photon's legacy behavior differs (repeated params), legacy wins — that's the point of the adapter.
- `erasableSyntaxOnly`; `.ts` relative imports; acronym casing (whole camelCase components); both exports maps on any changed `package.json`; no raw `process.env`/`process.argv`; compile before running anything against `out/`; `yarn oxfmt` before committing; commit lockfile deltas WITH the change that caused them (phase-1 lesson).
- **No new workspace this phase** — the 5-point registration checklist (root package.json, root tsconfig, `.release-it.json`, `scripts/smoke-clean-install.ts`, root `vitest.config.ts` alias) is N/A for photon (already registered everywhere) and already done for api-kit. Task 6 still runs `smoke-clean-install` as the receipt.
- New-file tsconfig lesson (phase 1): `photon/tsconfig.json` will need a `../api-kit` project reference, `resolveJsonModule: true`, and a literal `"files": ["./package.json"]` entry for the self-referencing package.json import — encode upfront, don't rediscover.

---

### Task 1: api-kit GeoJSON wire atoms

**Files:**

- Create: `api-kit/geo.ts`
- Create: `api-kit/geo.test.ts`
- Modify: `api-kit/index.ts` (add re-export)

**Interfaces:**

- Consumes: `z` from `@hono/zod-openapi` (already an api-kit dependency).
- Produces (photon's `schema.ts` imports these; nominatim reuses them in phase 3):
  - `PointGeometrySchema` — zod object `{ type: "Point", coordinates: [number, number] }`.
  - `featureSchema<P>(properties: P)` — GeoJSON Feature envelope over a properties schema.
  - `featureCollectionSchema<F>(feature: F)` — FeatureCollection envelope over a feature schema.
  - `BBoxSchema` — `[number, number, number, number]` tuple.
  - Deliberate deferral (YAGNI, phase-1 precedent): `LonLat` atom waits for its first consumer (nominatim, phase 3).

- [ ] **Step 1: Write the failing tests** (`api-kit/geo.test.ts`)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "@hono/zod-openapi"
import { expect, test } from "vitest"

import { BBoxSchema, featureCollectionSchema, featureSchema, PointGeometrySchema } from "./index.ts"

test("PointGeometrySchema: accepts a lon/lat point, rejects wrong arity", () => {
	expect(PointGeometrySchema.safeParse({ type: "Point", coordinates: [13.405, 52.52] }).success).toBe(true)
	expect(PointGeometrySchema.safeParse({ type: "Point", coordinates: [13.405] }).success).toBe(false)
})

test("featureSchema: wraps a properties schema into a GeoJSON Feature envelope", () => {
	const schema = featureSchema(z.object({ name: z.string() }))
	const parsed = schema.safeParse({
		type: "Feature",
		geometry: { type: "Point", coordinates: [13.405, 52.52] },
		properties: { name: "Berlin" },
	})
	expect(parsed.success).toBe(true)
	expect(schema.safeParse({ type: "Feature", geometry: null, properties: { name: "x" } }).success).toBe(false)
})

test("featureCollectionSchema: wraps a feature schema into a FeatureCollection envelope", () => {
	const schema = featureCollectionSchema(featureSchema(z.object({}).loose()))
	expect(schema.safeParse({ type: "FeatureCollection", features: [] }).success).toBe(true)
	expect(schema.safeParse({ type: "FeatureCollection", features: [{}] }).success).toBe(false)
})

test("BBoxSchema: four finite numbers", () => {
	expect(BBoxSchema.safeParse([-5.1, 41.3, 9.6, 51.1]).success).toBe(true)
	expect(BBoxSchema.safeParse([1, 2, 3]).success).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run --dir ./api-kit`
Expected: FAIL — `geo.ts` exports missing.

- [ ] **Step 3: Implement `api-kit/geo.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GeoJSON wire atoms shared by the geo-shaped HTTP surfaces (photon, nominatim). Envelope
 *   builders only — surface-specific property schemas live with their routes, per the anti-meta
 *   guardrails in the 2026-07-12 design spec.
 */

import { z } from "@hono/zod-openapi"

/** A GeoJSON Point geometry: `[lon, lat]`. */
export const PointGeometrySchema = z
	.object({
		type: z.literal("Point"),
		coordinates: z.tuple([z.number(), z.number()]),
	})
	.openapi("PointGeometry")

/** A `[minLon, minLat, maxLon, maxLat]`-style 4-tuple (photon's `extent` uses `[minLon, maxLat, maxLon, minLat]`). */
export const BBoxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

/** GeoJSON Feature envelope over a surface-specific properties schema. */
export function featureSchema<P extends z.ZodTypeAny>(properties: P) {
	return z.object({
		type: z.literal("Feature"),
		geometry: PointGeometrySchema,
		properties,
	})
}

/** GeoJSON FeatureCollection envelope over a feature schema. */
export function featureCollectionSchema<F extends z.ZodTypeAny>(feature: F) {
	return z.object({
		type: z.literal("FeatureCollection"),
		features: z.array(feature),
	})
}
```

- [ ] **Step 4: Add `export * from "./geo.ts"` to `api-kit/index.ts`**

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn vitest run --dir ./api-kit`
Expected: 7 passed (3 prior + 4 new).

- [ ] **Step 6: Compile, format, commit**

Run: `yarn compile` (clean), `yarn oxfmt api-kit`

```bash
git add api-kit
git commit -m "feat(api-kit): GeoJSON wire atoms (Point/Feature/FeatureCollection/BBox)"
```

---

### Task 2: Split photon's engine + projection + schemas out of `index.ts`

**Files:**

- Create: `photon/engine.ts`
- Create: `photon/projection.ts`
- Create: `photon/schema.ts`
- Modify: `photon/index.ts`
- Modify: `photon/package.json` (add deps), `photon/tsconfig.json` (api-kit ref + JSON import support)
- Test: `photon/index.test.ts` (existing — stays green UNCHANGED through this task)

**Interfaces:**

- Consumes: Task 1's geo atoms; `@hono/zod-openapi`'s `z`.
- Produces:
  - `photon/engine.ts` — moved VERBATIM from `index.ts`: `PhotonProperties`, `PhotonFeature`, `PhotonFeatureCollection`, `PhotonSearchParams`, `PhotonReverseParams`, `PhotonEngine`, `photonFeature`, `photonCollection`.
  - `photon/projection.ts` — moved VERBATIM: `PhotonForwardInput`, `PhotonForwardResult`, `FORWARD_TAG_PROJECTION` (module-private, as now), `DEFAULT_OSM_TAGS` (module-private), `photonOSMTags`, `photonForwardProperties`, `photonForwardFeature`, `photonForwardCollection`, `photonFeatureToSchemaOrg`, `photonToSchemaOrg` (the `@mailwoman/annotations` import moves with them).
  - `photon/schema.ts` — NEW zod wire schemas (doc-exact, validator-proof):
    - `PhotonPropertiesSchema` (loose object mirroring the wire keys), `PhotonFeatureSchema = featureSchema(PhotonPropertiesSchema)`, `PhotonFeatureCollectionSchema = featureCollectionSchema(PhotonFeatureSchema)`
    - `PhotonMessageCollectionSchema` — the error/degenerate envelope (FeatureCollection + `message`)
    - `searchQueryParams` + `reverseQueryParams` (built on a module-private `tolerantParam`; exact code below)
  - `photon/index.ts` — re-exports `./engine.ts`, `./projection.ts`, `./schema.ts`; express router code REMAINS COMPILING (Task 3 deletes it).

- [ ] **Step 1: Add deps.** `photon/package.json` dependencies gain (alphabetized): `"@hono/zod-openapi": "^1.4.0"`, `"@mailwoman/api-kit": "workspace:*"`, `"hono": "^4.12.29"`, `"zod": "^4.4.3"`. (`express` stays until Task 3.) Run `yarn install`. The lockfile delta commits WITH this task.

- [ ] **Step 2: tsconfig.** In `photon/tsconfig.json` `compilerOptions` add `"resolveJsonModule": true`; add top-level `"files": ["./package.json"]` alongside `include`; set `"references": [{ "path": "../api-kit" }]` (phase-1 lesson — tsc's composite TS6307 check requires the literal files entry for the self-referencing package.json import that Task 3's `app.ts` performs).

- [ ] **Step 3: Move the engine block** (index.ts lines ~20–104: the two param interfaces, the three wire types, `PhotonEngine`, `photonFeature`, `photonCollection` — note `photonFeature`/`photonCollection` live further down in index.ts, lines ~272–280; move them into `engine.ts` with the types) into `photon/engine.ts`, verbatim, with the standard header. Docstring: the engine contract + wire types; projection lives in `projection.ts`.

- [ ] **Step 4: Move the projection block** (index.ts lines ~282–478: `PhotonForwardInput` through `photonToSchemaOrg`, plus `FORWARD_TAG_PROJECTION`/`DEFAULT_OSM_TAGS` from ~321–342) into `photon/projection.ts`, verbatim, importing `type PhotonFeature, type PhotonFeatureCollection, type PhotonProperties, photonFeature, photonCollection` from `./engine.ts` and keeping the `@mailwoman/annotations` import. Every `#1014`/`#1041`/`#1050`/`#1052` comment moves intact.

- [ ] **Step 5: Write `photon/schema.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the Photon-compatible surface. Key names and envelopes are the vendor
 *   contract — immutable. Query schemas are validator-proof by construction (unions accepting
 *   string or repeated values) with doc-exact `.openapi()` overrides: validation can never fail,
 *   and every wire decision stays in the handlers (see routes.ts's legacyQuery adapter).
 */

import { featureCollectionSchema, featureSchema } from "@mailwoman/api-kit"
import { z } from "@hono/zod-openapi"

/** Photon feature properties — OSM-derived keys; tolerant of extras (`[key: string]: unknown` on the wire type). */
export const PhotonPropertiesSchema = z
	.object({
		osm_id: z.union([z.number(), z.string()]).optional(),
		osm_type: z.string().optional(),
		osm_key: z.string().optional(),
		osm_value: z.string().optional(),
		type: z.string().optional(),
		name: z.string().optional(),
		housenumber: z.string().optional(),
		street: z.string().optional(),
		postcode: z.string().optional(),
		city: z.string().optional(),
		district: z.string().optional(),
		county: z.string().optional(),
		state: z.string().optional(),
		country: z.string().optional(),
		countrycode: z.string().optional(),
		extent: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
	})
	.loose()
	.openapi("PhotonProperties")

export const PhotonFeatureSchema = featureSchema(PhotonPropertiesSchema).openapi("PhotonFeature")

export const PhotonFeatureCollectionSchema =
	featureCollectionSchema(PhotonFeatureSchema).openapi("PhotonFeatureCollection")

/** The error/degenerate envelope: an EMPTY FeatureCollection carrying a message. Never `{error}` on this surface. */
export const PhotonMessageCollectionSchema = z
	.object({
		type: z.literal("FeatureCollection"),
		features: z.array(PhotonFeatureSchema),
		message: z.string(),
	})
	.openapi("PhotonMessageCollection")

/**
 * A query param that may legally repeat (or that a client may repeat without the validator being
 * allowed to answer for us). Validator-proof: accepts one value or many; the doc override keeps the
 * emitted parameter schema exact.
 */
const tolerantParam = z.union([z.string(), z.array(z.string())]).optional()

/** `GET /api` query — documented shape; presence/parsing enforced in-handler. */
export const searchQueryParams = z.object({
	q: tolerantParam.openapi({ type: "string", description: "The query string to search for." }),
	limit: tolerantParam.openapi({ type: "integer", description: "Maximum results (default 15)." }),
	lang: tolerantParam.openapi({ type: "string", description: "Preferred language." }),
	lat: tolerantParam.openapi({ type: "number", description: "Location-bias latitude." }),
	lon: tolerantParam.openapi({ type: "number", description: "Location-bias longitude." }),
	osm_tag: tolerantParam.openapi({
		type: "array",
		items: { type: "string" },
		description: "OSM tag filter; repeatable.",
	}),
	layer: tolerantParam.openapi({ type: "array", items: { type: "string" }, description: "Layer filter; repeatable." }),
	format: tolerantParam.openapi({ type: "string", enum: ["geojson", "jsonld"], description: "Output format." }),
})

/** `GET /reverse` query. */
export const reverseQueryParams = z.object({
	lat: tolerantParam.openapi({ type: "number", description: "Latitude." }),
	lon: tolerantParam.openapi({ type: "number", description: "Longitude." }),
	limit: tolerantParam.openapi({ type: "integer", description: "Maximum results (default 15)." }),
	lang: tolerantParam.openapi({ type: "string", description: "Preferred language." }),
	radius: tolerantParam.openapi({ type: "number", description: "Search radius in km." }),
	format: tolerantParam.openapi({ type: "string", enum: ["geojson", "jsonld"], description: "Output format." }),
})
```

(If the emitted parameter schemas surface the union instead of the override, that is adjudicated at Task 4's gate — the override mechanism is the intent; verify with `emitOpenAPIDocuments` during Task 3's doc test.)

- [ ] **Step 6: Rewire `photon/index.ts`.** Delete the moved blocks; add `export * from "./engine.ts"`, `export * from "./projection.ts"`, `export * from "./schema.ts"` above the remaining express code; add the minimal imports the remaining express router needs (`type PhotonEngine`, `photonCollection`, etc. — `export *` doesn't bind local names; phase-1 Task 3 did the same). Express router stays functional.

- [ ] **Step 7: Run the existing tests — UNCHANGED**

Run: `yarn vitest run --dir ./photon`
Expected: every existing test passes with zero test-file edits.

- [ ] **Step 8: Compile, format, commit**

Run: `yarn compile` (clean), `yarn oxfmt photon`

```bash
git add photon yarn.lock
git commit -m "refactor(photon): split engine, projection, and zod wire schemas out of index.ts"
```

---

### Task 3: photon routes + app on Hono; port the test suite

**Files:**

- Create: `photon/routes.ts`
- Create: `photon/app.ts`
- Modify: `photon/index.ts` (delete all express code; re-export `./app.ts`)
- Modify: `photon/package.json` (drop `express`)
- Modify: `photon/index.test.ts` (port to `app.request()`; add pinning tests)
- Modify: `photon/cli.ts` (MINIMAL compile fix only — Task 5 owns the real rewrite)

**Interfaces:**

- Consumes: Task 2's engine/projection/schema exports; api-kit's `attachOpenAPIDocs`.
- Produces:
  - `createPhotonApp(engine: PhotonEngine, options?: PhotonAppOptions): OpenAPIHono` with `PhotonAppOptions = { cors?: boolean }` (default true — upstream komoot parity).
  - `registerPhotonRoutes(app: OpenAPIHono, engine: PhotonEngine): void`.
  - `createPhotonRouter`/`PhotonRouterOptions` no longer exist.

**The wire-parity core — the `legacyQuery` adapter.** Express's `req.query` yields `string` for a single value and `string[]` for repeats; ALL legacy parsing (`asString`, `asStringArray`, `Number(...)`) keyed off that shape, and its degenerate behaviors are observable contract: repeated `q` → `asString(array)` → undefined → 400; repeated `lat` on `/reverse` → `Number(array)` → NaN → 400 (`"lat and lon are required"`); `Number(["1"])` → 1. Reproduce the shape, then move the original logic verbatim on top of it:

```ts
/**
 * Express's `req.query` shape: `string` for a single value, `string[]` for repeats. The legacy
 * parsing helpers (`asString`, `asStringArray`, `Number(...)`) — and their observable degenerate
 * behaviors (repeated `q` → 400, repeated `lat` → NaN → 400) — key off exactly this shape, so the
 * handlers consume it unchanged. Do NOT dedup or canonicalize here: photon's repeatable params
 * (`osm_tag`, `layer`) are contract, and its duplicate-param 400s are contract too (unlike
 * libpostal, where duplicates were never-contract — see the phase-1 adjudications).
 */
function legacyQuery(c: Context): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {}

	for (const [key, values] of Object.entries(c.req.queries())) {
		out[key] = values.length === 1 ? values[0]! : values
	}

	return out
}
```

- [ ] **Step 1: Drop `express` from `photon/package.json` dependencies.** Run `yarn install`; the lockfile delta commits with this task.

- [ ] **Step 2: Port the test file.** Rewrite `photon/index.test.ts` onto `app.request()`: every existing behavioral assertion carries over (engine fixtures instead of listeners — no `withServer`). Import `createPhotonApp` in place of `createPhotonRouter`+express. Then ADD these pinning tests (exact code):

```ts
test("repeated q answers the legacy 400 envelope (express array shape preserved)", async () => {
	const app = createPhotonApp(searchEngine)
	const res = await app.request("/api?q=berlin&q=paris")
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ type: "FeatureCollection", features: [], message: "q is required" })
})

test("repeated lat on /reverse answers the legacy 400 (Number(array) is NaN)", async () => {
	const app = createPhotonApp(reverseEngine)
	const res = await app.request("/reverse?lat=52.5&lat=52.6&lon=13.4")
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ type: "FeatureCollection", features: [], message: "lat and lon are required" })
})

test("repeated osm_tag and layer reach the engine as arrays (contractual repeatable params)", async () => {
	let seen: PhotonSearchParams | undefined
	const app = createPhotonApp({
		search: async (params) => {
			seen = params

			return { type: "FeatureCollection", features: [] }
		},
	})
	const res = await app.request("/api?q=berlin&osm_tag=place:city&osm_tag=place:town&layer=city&layer=locality")
	expect(res.status).toBe(200)
	expect(seen?.osmTag).toEqual(["place:city", "place:town"])
	expect(seen?.layer).toEqual(["city", "locality"])
})

test("limit falls back to 15 on absent, non-numeric, and zero values (legacy Number(x) || 15)", async () => {
	const seen: number[] = []
	const app = createPhotonApp({
		search: async (params) => {
			seen.push(params.limit)

			return { type: "FeatureCollection", features: [] }
		},
	})

	for (const suffix of ["", "&limit=abc", "&limit=0"]) {
		await app.request(`/api?q=berlin${suffix}`)
	}
	expect(seen).toEqual([15, 15, 15])
})

test("non-numeric bias lat/lon on /api is tolerated (soft bias — NaN reaches the engine, no 400)", async () => {
	let seen: PhotonSearchParams | undefined
	const app = createPhotonApp({
		search: async (params) => {
			seen = params

			return { type: "FeatureCollection", features: [] }
		},
	})
	const res = await app.request("/api?q=berlin&lat=abc&lon=13.4")
	expect(res.status).toBe(200)
	expect(Number.isNaN(seen?.lat)).toBe(true)
})

test("out-of-range /reverse coordinates answer the exact range 400", async () => {
	const app = createPhotonApp(reverseEngine)
	const res = await app.request("/reverse?lat=91&lon=13.4")
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({
		type: "FeatureCollection",
		features: [],
		message: "lat must be in [-90, 90] and lon in [-180, 180]",
	})
})

test("GET /openapi.json serves the emitted 3.1 document", async () => {
	const app = createPhotonApp(searchEngine)
	const res = await app.request("/openapi.json")
	expect(res.status).toBe(200)
	const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
	expect(doc.openapi).toBe("3.1.0")
	expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/", "/api", "/reverse"]))
})
```

(`searchEngine`/`reverseEngine` are fixture engines the existing suite already defines or trivially provides: `search` returning a fixed collection, `reverse` returning a fixed collection.)

- [ ] **Step 3: Run tests — new ones fail on missing `createPhotonApp`**

Run: `yarn vitest run --dir ./photon`
Expected: ported+new tests FAIL (`createPhotonApp` not exported); nothing else.

- [ ] **Step 4: Implement `photon/routes.ts`.** Structure (complete file; the handler bodies are the legacy code moved verbatim onto `legacyQuery`):

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route definitions + handlers for the Photon-compatible surface. The OpenAPI document is
 *   emitted from these definitions — no handwritten spec. Handlers parse params from the
 *   `legacyQuery` express-shaped view; the zod query schemas drive only the emitted document.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"

import {
	type PhotonEngine,
	type PhotonFeatureCollection,
	type PhotonReverseParams,
	type PhotonSearchParams,
} from "./engine.ts"
import { photonToSchemaOrg } from "./projection.ts"
import {
	PhotonFeatureCollectionSchema,
	PhotonMessageCollectionSchema,
	reverseQueryParams,
	searchQueryParams,
} from "./schema.ts"

const DEFAULT_LIMIT = 15

const EMPTY: PhotonFeatureCollection = { type: "FeatureCollection", features: [] }

/* asString + asStringArray move VERBATIM from the old index.ts here. */

/* legacyQuery — the adapter from this task's header, verbatim. */

/* ROOT_HTML moves VERBATIM from the old index.ts here. */

const messageContent = (description: string) => ({
	description,
	content: { "application/json": { schema: PhotonMessageCollectionSchema } },
})

const collectionResponses = {
	200: {
		description: "A GeoJSON FeatureCollection (or schema.org Place[] when format=jsonld).",
		content: { "application/json": { schema: PhotonFeatureCollectionSchema } },
	},
	400: messageContent("A required or malformed parameter."),
	500: messageContent("An unexpected engine fault. An empty FeatureCollection with a message, never a crash."),
	501: messageContent("The backing engine method is not wired for this deployment."),
}

const rootRoute = createRoute({
	method: "get",
	path: "/",
	operationId: "getRoot",
	summary: "Landing page",
	tags: ["meta"],
	responses: { 200: { description: "HTML landing page.", content: { "text/html": { schema: z.string() } } } },
})

const searchRoute = createRoute({
	method: "get",
	path: "/api",
	operationId: "search",
	summary: "Forward / autocomplete geocoding",
	tags: ["geocoding"],
	request: { query: searchQueryParams },
	responses: collectionResponses,
})

const reverseRoute = createRoute({
	method: "get",
	path: "/reverse",
	operationId: "reverse",
	summary: "Reverse geocoding",
	tags: ["geocoding"],
	request: { query: reverseQueryParams },
	responses: collectionResponses,
})

/** Register the Photon-compatible routes against an injected engine. */
export function registerPhotonRoutes(app: OpenAPIHono, engine: PhotonEngine): void {
	app.openapi(rootRoute, (c) => c.html(ROOT_HTML))

	app.openapi(searchRoute, async (c) => {
		if (!engine.search) return c.json({ ...EMPTY, message: "search not implemented" }, 501)
		const q = legacyQuery(c)
		const query = asString(q["q"])

		if (!query) return c.json({ ...EMPTY, message: "q is required" }, 400)
		const params: PhotonSearchParams = {
			q: query,
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			lang: asString(q["lang"]),
			lat: q["lat"] != null ? Number(q["lat"]) : undefined,
			lon: q["lon"] != null ? Number(q["lon"]) : undefined,
			osmTag: asStringArray(q["osm_tag"]),
			layer: asStringArray(q["layer"]),
		}
		const collection = await engine.search(params)

		// #1052: `format=jsonld` re-serializes the SAME FeatureCollection as schema.org `Place[]` JSON-LD.
		return c.json(asString(q["format"]) === "jsonld" ? photonToSchemaOrg(collection) : collection, 200)
	})

	app.openapi(reverseRoute, async (c) => {
		if (!engine.reverse) return c.json({ ...EMPTY, message: "reverse not implemented" }, 501)
		const q = legacyQuery(c)
		const lat = Number(q["lat"])
		const lon = Number(q["lon"])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return c.json({ ...EMPTY, message: "lat and lon are required" }, 400)
		}

		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			return c.json({ ...EMPTY, message: "lat must be in [-90, 90] and lon in [-180, 180]" }, 400)
		}
		const params: PhotonReverseParams = {
			lat,
			lon,
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			lang: asString(q["lang"]),
			radius: q["radius"] != null ? Number(q["radius"]) : undefined,
		}
		const collection = await engine.reverse(params)

		// #1052: `format=jsonld` re-serializes the reverse FeatureCollection as schema.org `Place[]` JSON-LD.
		return c.json(asString(q["format"]) === "jsonld" ? photonToSchemaOrg(collection) : collection, 200)
	})
}
```

(If `app.openapi`'s handler typing rejects the union of response shapes — jsonld returns an array — use a local cast per the phase-1 note; never change wire behavior to satisfy types. The jsonld 200 body being a `SchemaOrgPlace[]` rather than the documented FeatureCollection matches the legacy yaml's own treatment — verify what the yaml documents for `format=jsonld` during Task 4 and adjudicate there.)

- [ ] **Step 5: Implement `photon/app.ts`** — mirrors phase 1's `libpostal/app.ts` shape exactly: `OpenAPIHono` + `cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["*"], maxAge: 86400 })` when `options.cors !== false` (NOTE: no POST in the methods list — photon is GET-only), `app.onError((_e, c) => c.json({ type: "FeatureCollection", features: [], message: "internal error" }, 500))` (photon's envelope, NOT `{error}`), `registerPhotonRoutes(app, engine)`, `attachOpenAPIDocs(app, { title: packageJson.name, version: packageJson.version })` with the self-referencing `import packageJson from "@mailwoman/photon/package.json" with { type: "json" }`. Doc comment for `PhotonAppOptions.cors` carries the full #1017 rationale from the old `PhotonRouterOptions.cors`.

- [ ] **Step 6: Gut `photon/index.ts`** — header docstring updated (`createPhotonApp` replaces `createPhotonRouter`; Hono app; engine contract in `engine.ts`, projection in `projection.ts`), then four re-exports: `./app.ts`, `./engine.ts`, `./projection.ts`, `./schema.ts`.

- [ ] **Step 7: Minimal `photon/cli.ts` compile fix** — swap `createPhotonRouter` + express boot for `createPhotonApp` + `serveNode` (api-kit), keeping every flag, gazetteer-resolution branch, #1009 error, and banner line as-is. Flag it in your report; Task 5 reconciles fully.

- [ ] **Step 8: Run tests to verify they pass**

Run: `yarn vitest run --dir ./photon`
Expected: all ported + new tests pass, pristine output.

- [ ] **Step 9: Compile, format, commit**

Run: `yarn compile` (clean — repo-wide), `yarn oxfmt photon`

```bash
git add photon yarn.lock
git commit -m "feat(photon)!: express Router -> Hono app with emitted OpenAPI document"
```

---

### Task 4: Spec-parity gate — emitted document vs `photon/openapi.yaml`, then retire the yaml

**Files:**

- Create: `photon/openapi-parity.test.ts` (temporary — deleted at the end of this task; plan-mandated)
- Delete: `photon/openapi.yaml`
- Modify: `photon/package.json` (drop `"openapi.yaml"` from `files` if present)

**Interfaces:**

- Consumes: `createPhotonApp`, api-kit's `emitOpenAPIDocuments`, the `yaml` package (add `"yaml": "^2.8.1"` to photon devDependencies if not resolvable — commit lockfile with it).
- Produces: an adjudication record in the commit message; no handwritten photon spec.

- [ ] **Step 1: Write the parity test** — same three assertions as phase 1, verbatim mechanism (legacy paths ⊆ emitted; per-operation parameter NAME sets equal; per-operation status-code sets equal), against `parseYAML(readFileSync(new URL("./openapi.yaml", import.meta.url), "utf8"))` and `emitOpenAPIDocuments(createPhotonApp({}), { title: "@mailwoman/photon", version: "0.0.0" }).v31`. (An empty engine `{}` is valid — both methods optional; routes still register.)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ONE-TIME migration gate (deleted once adjudicated): the emitted OpenAPI document must cover
 *   the handwritten openapi.yaml's contract — every path, method, parameter, and status code.
 */

import { readFileSync } from "node:fs"

import { emitOpenAPIDocuments } from "@mailwoman/api-kit"
import { expect, test } from "vitest"
import { parse as parseYAML } from "yaml"

import { createPhotonApp } from "./app.ts"

interface OperationShape {
	parameters?: { name: string; required?: boolean }[]
	responses: Record<string, unknown>
}
type PathsShape = Record<string, Record<string, OperationShape>>

const legacy = parseYAML(readFileSync(new URL("./openapi.yaml", import.meta.url), "utf8")) as { paths: PathsShape }

const emitted = emitOpenAPIDocuments(createPhotonApp({}), {
	title: "@mailwoman/photon",
	version: "0.0.0",
}).v31 as { paths: PathsShape }

test("every legacy path + method exists in the emitted document", () => {
	for (const [path, operations] of Object.entries(legacy.paths)) {
		expect(emitted.paths, `missing path ${path}`).toHaveProperty([path])

		for (const method of Object.keys(operations)) {
			expect(emitted.paths[path], `missing ${method.toUpperCase()} ${path}`).toHaveProperty([method])
		}
	}
})

test("every legacy query parameter is declared on the emitted operation", () => {
	for (const [path, operations] of Object.entries(legacy.paths)) {
		for (const [method, operation] of Object.entries(operations)) {
			const legacyParams = (operation.parameters ?? []).map((p) => p.name).sort()
			const emittedParams = ((emitted.paths[path]?.[method]?.parameters ?? []) as { name: string }[])
				.map((p) => p.name)
				.sort()

			expect(emittedParams, `${method.toUpperCase()} ${path} parameters`).toEqual(legacyParams)
		}
	}
})

test("every legacy status code is declared on the emitted operation", () => {
	for (const [path, operations] of Object.entries(legacy.paths)) {
		for (const [method, operation] of Object.entries(operations)) {
			const legacyCodes = Object.keys(operation.responses).sort()
			const emittedCodes = Object.keys(emitted.paths[path]?.[method]?.responses ?? {}).sort()

			expect(emittedCodes, `${method.toUpperCase()} ${path} responses`).toEqual(legacyCodes)
		}
	}
})
```

- [ ] **Step 2: Run and adjudicate.** `yarn vitest run --dir ./photon --reporter=verbose`. Every failure is either a routes.ts bug (fix, re-run) or a yaml bug (record). Likely candidates to check deliberately: `bbox` (the legacy router never parsed it — if the yaml documents it, that's a yaml-side overpromise to record AND a decision point: add it to `searchQueryParams` as documented-but-unparsed, or record its absence; prefer matching the yaml's parameter list so the gate passes with the param declared, since `PhotonSearchParams.bbox` already exists on the engine interface — but do NOT wire parsing, that would be new behavior); `format=jsonld`'s 200 body shape; any parameter the yaml documents that the router ignored. If a difference can't be confidently classified, STOP and report BLOCKED with the exact diff.

- [ ] **Step 3: Retire.** `git rm photon/openapi.yaml`; drop `"openapi.yaml"` from `photon/package.json` `files` (if listed); `rm` the parity test (never staged). Full suite + compile green.

- [ ] **Step 4: Commit** with the adjudication list in the body (phase-1 c44f4c1e is the model):

```bash
git add -A photon
git commit -m "feat(photon): retire the handwritten OpenAPI yaml — the emitted document is the spec

Parity gate adjudications: <the real list from Step 2>"
```

---

### Task 5: CLI onto `serveNode`; README; end-to-end smoke

**Files:**

- Modify: `photon/cli.ts` (reconcile the Task 3 minimal swap into the final form)
- Modify: `photon/README.md`
- Test: manual smoke against the compiled CLI

**Interfaces:**

- Consumes: `createPhotonApp`, `serveNode`. ALL engine wiring, gazetteer resolution (`--candidate-db`, `$MAILWOMAN_CANDIDATE_DB`, the #1009 friendly-error paths), and flag handling are UNTOUCHED.
- Produces: `mailwoman-photon serve [--port 2322] [--host 0.0.0.0] [--candidate-db <path>] [--no-cors]` — identical flags and banner shape, plus a `GET /openapi.json` mention in the endpoints line.

- [ ] **Step 1: Reconcile `photon/cli.ts`.** The boot becomes:

```ts
const app = createPhotonApp(engine, { cors: values.cors })

serveNode({
	fetch: app.fetch,
	port,
	hostname: host,
	onListen: () => {
		console.error(`[@mailwoman/photon] listening on http://${host}:${port}`)
		console.error(`  wof: ${adminDBPath ?? "(none found — set MAILWOMAN_WOF_DB)"}`)
		console.error(
			candidateDb
				? `  resolver: candidate gazetteer (worldwide) — ${candidateDb}`
				: `  resolver: admin-only (US-optimized) — point --candidate-db / $MAILWOMAN_CANDIDATE_DB at a candidate gazetteer for worldwide`
		)
		console.error(`  cors: ${values.cors ? "enabled (Access-Control-Allow-Origin: *)" : "disabled (--no-cors)"}`)
		console.error(`  endpoints: GET /api  GET /reverse  GET /openapi.json`)
	},
})
```

The `const express = (await import("express")).default` dynamic import is deleted. Header docstring: swap the router mention for `createPhotonApp`. Everything else stays byte-identical.

- [ ] **Step 2: Update `photon/README.md`.** Swap any express/`createPhotonRouter` snippet for `createPhotonApp` + `serveNode`; document `GET /openapi.json`; keep all curl examples byte-identical.

- [ ] **Step 3: Compile + smoke** (the engine needs gazetteer data — the lab data-root has `wof/candidate.db`; if boot fails on missing data, report the exact #1009 message as BLOCKED rather than improvising):

```bash
yarn compile
node photon/out/cli.js serve --port 12322 &
SERVER_PID=$!
sleep 10   # model + gazetteer load
curl -s 'http://127.0.0.1:12322/api?q=berlin&limit=3' | head -c 400; echo
curl -s 'http://127.0.0.1:12322/api?q=berlin&limit=3&format=jsonld' | head -c 200; echo
curl -s 'http://127.0.0.1:12322/reverse?lat=52.52&lon=13.405' | head -c 300; echo
curl -s 'http://127.0.0.1:12322/api' ; echo
curl -s 'http://127.0.0.1:12322/openapi.json' | head -c 200; echo
kill "$SERVER_PID"   # the exact PID of OUR spawn — NEVER pkill by pattern (production-incident rule)
```

Expected: `/api?q=berlin` returns a FeatureCollection with features; jsonld returns a JSON array of schema.org Places; `/reverse` returns a feature for Berlin; bare `/api` returns the exact `{"type":"FeatureCollection","features":[],"message":"q is required"}`; `/openapi.json` starts `{"openapi":"3.1.0"`.

- [ ] **Step 4: Format + commit**

```bash
yarn oxfmt photon
git add photon
git commit -m "feat(photon): serve via api-kit serveNode; emitted OpenAPI at /openapi.json"
```

---

### Task 6: Repo-wide green + branch wrap

**Files:** verification only; fix-forward what it surfaces.

- [ ] **Step 1: Clean-tree rebuild:** `rm -rf api-kit/out photon/out && yarn compile` — clean.
- [ ] **Step 2: Suites:** `yarn vitest run --dir ./photon` and `yarn vitest run --dir ./api-kit` (separate invocations — vitest rejects two `--dir` flags); `yarn test:integration`.
- [ ] **Step 3: Publish-safety receipt:** `node scripts/smoke-clean-install.ts` — photon is already in the smoke closure; this catches any dependency-graph regression (phase-1 lesson: this receipt, not lint, guards installability).
- [ ] **Step 4: Lint:** `yarn lint:oxlint`; `yarn oxfmt --check api-kit photon`.
- [ ] **Step 5: Express references:** `grep -rn "express" photon --include="*.ts" --include="*.json" | grep -v out/` — no hits (historical test-description prose exempt, as phase 1).
- [ ] **Step 6: Push + PR** (branch `feat/hono-photon` — create it off main at phase start if Task 1 hasn't already; all tasks commit to it):

```bash
git push -u origin feat/hono-photon
gh pr create --title "feat!: Hono API surface, phase 2 — api-kit geo atoms + photon migration" --body "<spec/plan links; geo atoms; legacyQuery adapter rationale (why photon does NOT get phase 1's canonicalizers — repeatable params and duplicate-param 400s are contract here); parity-gate adjudications; smoke receipts; breaking note (createPhotonRouter removed, no shim); next-major-train constraint. End with the Claude Code attribution line.>"
```

⚠ Do not merge the PR — operator's call. NOTE for the controller, not the implementer: the hosted `mailwoman-photon.service` systemd unit runs the OLD express CLI; redeploy is a post-merge operator step (standing plan: drop-in servers redeploy post-POSAIS).

---

## Deferred to later phases (per spec §Order)

- **Phase 3 (nominatim)**: nominatim migration + parity gate; `LonLat` atom lands with it.
- **Phase 4 (native API)**: `@mailwoman/api`, api-kit error envelope + metrics port, `mailwoman serve`, delete `mailwoman/server` + express repo-wide, graceful-shutdown story.
- **Phase 5 (CI clients)**: spec artifacts in the release workflow, Python/Rust generation, `feat/api-clients` closure, docs follow-up (orphaned static yamls + api.mdx links).
