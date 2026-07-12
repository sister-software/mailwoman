# Hono API surface, Phase 3: nominatim migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `@mailwoman/nominatim` from express to Hono + `@hono/zod-openapi` with the OpenAPI document emitted from the route table, retiring `nominatim/openapi.yaml` (the last handwritten drop-in spec) through the parity gate.

**Architecture:** The photon pattern (phase 2, merged as #1082), applied to nominatim's four GET endpoints. Same `legacyQuery` adapter (express-simple `string|string[]` query shape, null-prototype), same tolerant-union query schemas with doc-exact `.openapi()` overrides, same handlers-own-every-wire-decision mandate. The merged `photon/{engine,projection,schema,routes,app}.ts` files are the living exemplar — follow them structurally; this plan supplies the nominatim-specific code. No new api-kit atoms: nominatim's geojson envelope (`toFeatureCollection`) is its own vendor shape (polygon-capable `geometry: unknown`, result-field `properties`), not the api-kit Point envelope; the spec's `LonLat` atom stays deferred with no consumer (record in the PR).

**Tech Stack:** hono `^4.12.29`, `@hono/zod-openapi` `^1.4.0`, `@mailwoman/api-kit` (`serveNode`, `attachOpenAPIDocs`, `emitOpenAPIDocuments`), zod `^4.4.3`, vitest.

## Global Constraints

- **Vendor wire shapes are immutable.** Error envelope is `{error: string}` (libpostal-style, NOT photon's FeatureCollection+message). Exact bodies: 501s carry issue refs verbatim — `{"error":"search not implemented (see #802)"}`, `{"error":"reverse not implemented (see #803)"}`, `{"error":"lookup not implemented (see #805)"}`; 400s (reverse only): `{"error":"lat and lon are required"}`, `{"error":"lat must be in [-90, 90] and lon in [-180, 180]"}`; 500: `{"error":"internal error"}`. CORS methods `GET, OPTIONS`.
- **`/status` special default:** engine method absent → 200 `{"status":0,"message":"OK"}` — NOT 501. The only endpoint with a non-501 absent-method answer.
- **Format matrix:** `parseFormat` falls back to `"jsonv2"` for anything not in `{json, geojson, jsonld}`. `geojson` → `toFeatureCollection`; `jsonld` → schema.org projection on `/search` (array) and `/reverse` (single object or `null`); `/lookup` has NO jsonld branch (jsonld falls through to raw results — a legacy quirk to preserve); `/reverse` with a null engine result serializes `null` (json body `null`, 200).
- **`addressdetails` forcing:** `parseBool(q) || format === "jsonld"` on `/search` and `/reverse`; plain `parseBool` on `/lookup`.
- **Param parsing verbatim:** `asString` (repeated param → array → undefined, silently treated as absent — pin it), `parseBool` (`"1"`/`"true"`), `countrycodes`/`osm_ids` comma-split, `limit` = `Number(x ?? 10) || 10` (DEFAULT 10, not photon's 15), `accept-language` kebab param. `/search` has NO required params — bare `/search` reaches the engine with `q: undefined` (engine returns what it returns; pin with a fixture). `NominatimSearchParams.viewbox` exists on the interface but was never parsed and is NOT in the yaml — leave unparsed/undeclared (photon's bbox precedent).
- **Engine + formatter exports move verbatim** (public API): `NominatimFormat`, `NominatimAddressDetails`, `NominatimResult`, `NominatimSearchParams`, `NominatimReverseParams`, `NominatimLookupParams`, `NominatimStatus`, `NominatimEngine`, `NominatimFeatureCollection`, `toFeatureCollection`, `ResolvedAddress`, `MAILWOMAN_LICENCE`, `toNominatimResult`, `nominatimResultToSchemaOrg` (module-private `stableID`, `DEFAULT_LIMIT`, `parseFormat`, `parseBool`, `asString` move with their consumers). `createNominatimRouter`/`NominatimRouterOptions` deleted, no shim.
- **Adjudication consistency** with phases 1–2 (ledger `.superpowers/sdd/progress.md`): repeated single-valued params are never-contract-tolerated (legacy: `asString(array)` → undefined → param absent — that IS the observable contract, pin it, no 400); the yaml uses `$ref`-shared `components.parameters` (limit/addressdetails/format/accept-language) — the parity test MUST dereference them (phase-2 lesson, resolver code included below).
- `erasableSyntaxOnly`; `.ts` imports; acronym casing; both exports maps; lockfile deltas commit with their change; compile before `out/`; `yarn oxfmt` before commit; vitest takes one `--dir` per invocation; no raw `process.env`/argv.
- No new workspace; registration checklist N/A; Task 6 runs `smoke-clean-install` as the receipt.
- `nominatim/tsconfig.json` needs the phase-2 additions upfront: `"resolveJsonModule": true`, `"files": ["./package.json"]`, `../api-kit` reference.
- Carry-forward while touching these files: export `registerNominatimRoutes` from the package root (phase-4 `mailwoman serve` needs it; photon/libpostal get theirs in phase 4).

---

### Task 1: Split nominatim's engine + formatter + schemas out of `index.ts`

**Files:**

- Create: `nominatim/engine.ts`
- Create: `nominatim/format.ts`
- Create: `nominatim/schema.ts`
- Modify: `nominatim/index.ts`, `nominatim/package.json`, `nominatim/tsconfig.json`
- Test: `nominatim/index.test.ts` (existing 13 tests — stay green UNCHANGED)

**Interfaces:**

- Consumes: `z` from `@hono/zod-openapi`.
- Produces:
  - `nominatim/engine.ts` — moved VERBATIM from `index.ts`: `NominatimFormat`, `NominatimAddressDetails`, `NominatimResult`, `NominatimSearchParams`, `NominatimReverseParams`, `NominatimLookupParams`, `NominatimStatus`, `NominatimEngine`.
  - `nominatim/format.ts` — moved VERBATIM: `NominatimFeatureCollection`, `toFeatureCollection`, `ResolvedAddress`, `MAILWOMAN_LICENCE`, `stableID` (private), `toNominatimResult`, `nominatimResultToSchemaOrg` (the `@mailwoman/annotations` import moves here).
  - `nominatim/schema.ts` — NEW (exact code in Step 4).
  - `index.ts` re-exports all three; express router keeps compiling (Task 2 deletes it).

- [ ] **Step 1: Deps.** `nominatim/package.json` dependencies gain (alphabetized): `"@hono/zod-openapi": "^1.4.0"`, `"@mailwoman/api-kit": "workspace:*"`, `"hono": "^4.12.29"`, `"zod": "^4.4.3"` (express stays until Task 2). `yarn install`; lockfile commits with this task.

- [ ] **Step 2: tsconfig.** Add `"resolveJsonModule": true` to compilerOptions, top-level `"files": ["./package.json"]`, reference `{ "path": "../api-kit" }`.

- [ ] **Step 3: Moves.** Engine block (index.ts ~lines 26–127: `NominatimFormat` through `NominatimEngine`) → `engine.ts`. Formatter block (~143–180 `NominatimFeatureCollection`/`toFeatureCollection`; ~391–487 `ResolvedAddress` through `nominatimResultToSchemaOrg`, incl. `MAILWOMAN_LICENCE` + `stableID`) → `format.ts`, importing the types it needs from `./engine.ts`. Verbatim — every comment intact.

- [ ] **Step 4: Write `nominatim/schema.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the Nominatim-compatible surface. Key names and envelopes are the vendor
 *   contract — immutable. Query schemas are validator-proof (string|string[] unions, all optional)
 *   with doc-exact `.openapi()` overrides; every wire decision lives in the handlers (see
 *   routes.ts's legacyQuery adapter, the photon-established pattern).
 */

import { z } from "@hono/zod-openapi"

/** The `addressdetails=1` breakdown — OSM-derived keys; tolerant of extras. */
export const NominatimAddressDetailsSchema = z
	.object({
		house_number: z.string().optional(),
		road: z.string().optional(),
		neighbourhood: z.string().optional(),
		suburb: z.string().optional(),
		city: z.string().optional(),
		town: z.string().optional(),
		village: z.string().optional(),
		county: z.string().optional(),
		state: z.string().optional(),
		postcode: z.string().optional(),
		country: z.string().optional(),
		country_code: z.string().optional(),
	})
	.loose()
	.openapi("NominatimAddressDetails")

/** A single Nominatim result (the shape geopy and friends parse). */
export const NominatimResultSchema = z
	.object({
		place_id: z.union([z.number(), z.string()]),
		licence: z.string(),
		osm_type: z.string().optional(),
		osm_id: z.union([z.number(), z.string()]).optional(),
		lat: z.string(),
		lon: z.string(),
		display_name: z.string(),
		boundingbox: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional(),
		class: z.string().optional(),
		type: z.string().optional(),
		importance: z.number().optional(),
		place_rank: z.number().optional(),
		address: NominatimAddressDetailsSchema.optional(),
		geojson: z.unknown().optional(),
		annotations: z.looseObject({}).optional(),
	})
	.loose()
	.openapi("NominatimResult")

export const NominatimResultsSchema = z.array(NominatimResultSchema)

/** The `format=geojson` envelope — nominatim's own shape (polygon-capable geometry, result fields as properties). */
export const NominatimFeatureCollectionSchema = z
	.object({
		type: z.literal("FeatureCollection"),
		features: z.array(
			z.object({
				type: z.literal("Feature"),
				properties: z.looseObject({}),
				geometry: z.unknown(),
				bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
			})
		),
	})
	.openapi("NominatimFeatureCollection")

/** The `/status` payload. */
export const NominatimStatusSchema = z
	.object({
		status: z.number(),
		message: z.string(),
		data_updated: z.string().optional(),
	})
	.openapi("NominatimStatus")

/** The JSON error envelope (this surface uses `{error}`, unlike photon's FeatureCollection+message). */
export const ErrorSchema = z
	.object({
		error: z.string(),
	})
	.openapi("Error")

/** A validator-proof query param: accepts one value or repeats; the doc override keeps the emitted schema exact. */
const tolerantParam = z.union([z.string(), z.array(z.string())]).optional()

/** `GET /search` query. */
export const searchQueryParams = z.object({
	q: tolerantParam.openapi({
		type: "string",
		description: "Free-text query. Mutually exclusive with the structured fields.",
	}),
	street: tolerantParam.openapi({ type: "string", description: "Structured: house number and street name." }),
	city: tolerantParam.openapi({ type: "string", description: "Structured: city." }),
	county: tolerantParam.openapi({ type: "string", description: "Structured: county." }),
	state: tolerantParam.openapi({ type: "string", description: "Structured: state." }),
	country: tolerantParam.openapi({ type: "string", description: "Structured: country." }),
	postalcode: tolerantParam.openapi({ type: "string", description: "Structured: postal code." }),
	countrycodes: tolerantParam.openapi({
		type: "string",
		description: "Comma-separated ISO 3166-1 alpha-2 codes restricting results.",
	}),
	bounded: tolerantParam.openapi({ type: "string", enum: ["0", "1"], description: "Restrict to the viewbox." }),
	limit: tolerantParam.openapi({ type: "integer", description: "Maximum results (default 10)." }),
	addressdetails: tolerantParam.openapi({
		type: "string",
		enum: ["0", "1"],
		description: "Include the address breakdown.",
	}),
	format: tolerantParam.openapi({
		type: "string",
		enum: ["jsonv2", "json", "geojson", "jsonld"],
		description: "Output format (default jsonv2).",
	}),
	"accept-language": tolerantParam.openapi({ type: "string", description: "Preferred result language." }),
})

/** `GET /reverse` query. */
export const reverseQueryParams = z.object({
	lat: tolerantParam.openapi({ type: "number", description: "Latitude." }),
	lon: tolerantParam.openapi({ type: "number", description: "Longitude." }),
	zoom: tolerantParam.openapi({ type: "integer", description: "Detail level." }),
	addressdetails: tolerantParam.openapi({
		type: "string",
		enum: ["0", "1"],
		description: "Include the address breakdown.",
	}),
	format: tolerantParam.openapi({
		type: "string",
		enum: ["jsonv2", "json", "geojson", "jsonld"],
		description: "Output format (default jsonv2).",
	}),
	"accept-language": tolerantParam.openapi({ type: "string", description: "Preferred result language." }),
})

/** `GET /lookup` query. */
export const lookupQueryParams = z.object({
	osm_ids: tolerantParam.openapi({ type: "string", description: "Comma-separated OSM ids (N|W|R-prefixed)." }),
	addressdetails: tolerantParam.openapi({
		type: "string",
		enum: ["0", "1"],
		description: "Include the address breakdown.",
	}),
	format: tolerantParam.openapi({
		type: "string",
		enum: ["jsonv2", "json", "geojson", "jsonld"],
		description: "Output format (default jsonv2).",
	}),
})
```

(Match the yaml's documented parameter lists exactly — the gate compares names; if the yaml's `/lookup` also documents `accept-language`, add it here with the same tolerantParam pattern and note it. Verify against `nominatim/openapi.yaml` while writing.)

- [ ] **Step 5: Rewire `index.ts`** — delete moved blocks, add `export * from "./engine.ts"` / `"./format.ts"` / `"./schema.ts"` above the express code, add explicit imports the router still needs (`export *` doesn't bind locals).

- [ ] **Step 6: Verify + commit**

Run: `yarn vitest run --dir ./nominatim` (13/13 unchanged), `yarn compile`, `yarn oxfmt nominatim`

```bash
git add nominatim yarn.lock
git commit -m "refactor(nominatim): split engine, formatter, and zod wire schemas out of index.ts"
```

---

### Task 2: nominatim routes + app on Hono; port the test suite

**Files:**

- Create: `nominatim/routes.ts`
- Create: `nominatim/app.ts`
- Modify: `nominatim/index.ts` (docstring + re-exports only), `nominatim/package.json` (drop express), `nominatim/index.test.ts` (port + pinning tests), `nominatim/cli.ts` (full port — small enough to finish here; Task 4 reconciles)

**Interfaces:**

- Consumes: Task 1's exports; api-kit's `attachOpenAPIDocs`, `serveNode`; photon's merged `routes.ts`/`app.ts` as the structural exemplar (read them first).
- Produces: `createNominatimApp(engine: NominatimEngine, options?: NominatimAppOptions): OpenAPIHono` (`NominatimAppOptions = { cors?: boolean }`, default true); `registerNominatimRoutes(app, engine)` — BOTH re-exported from `index.ts` (registerNominatimRoutes is the phase-4 carry-forward). `createNominatimRouter`/`NominatimRouterOptions` gone.

- [ ] **Step 1: `nominatim/routes.ts`.** Copy photon's structure: `legacyQuery` (verbatim from `photon/routes.ts`, null-prototype version), `asString`/`parseFormat`/`parseBool`/`DEFAULT_LIMIT` moved verbatim from old index.ts, `ROOT_HTML` moved verbatim. Route definitions: `rootRoute` (GET /, text/html 200), `searchRoute` (GET /search, query `searchQueryParams`, responses 200 `NominatimResultsSchema` + 500/501 `ErrorSchema`), `reverseRoute` (GET /reverse, query `reverseQueryParams`, responses 200 `NominatimResultSchema` + 400/500/501 `ErrorSchema`), `lookupRoute` (GET /lookup, query `lookupQueryParams`, responses 200 `NominatimResultsSchema` + 500/501 `ErrorSchema`), `statusRoute` (GET /status, responses 200 `NominatimStatusSchema` + 500 `ErrorSchema`). Handler bodies = the express handlers moved onto `legacyQuery(c)`, byte-parity: 501 issue-ref bodies, `/status` absent-method 200 default, the exact format-branch ladders (including `/lookup`'s missing jsonld branch and `/reverse`'s `null` serialization), `addressdetails: parseBool(...) || q["format"] === "jsonld"` on search/reverse only. jsonld/geojson/null response-shape unions: local casts per the photon note if typing fights — never change wire behavior. Sanity-check the exact status-code sets against the yaml's documented responses per operation while writing (the gate will verify; look once now to avoid a gate round-trip).

- [ ] **Step 2: `nominatim/app.ts`** — photon's app.ts shape: cors `GET, OPTIONS` (`allowMethods: ["GET", "OPTIONS"]`, `allowHeaders: ["*"]`, `maxAge: 86400`) when `options.cors !== false`; `app.onError((_e, c) => c.json({ error: "internal error" }, 500))`; `registerNominatimRoutes(app, engine)`; `attachOpenAPIDocs(app, { title: packageJson.name, version: packageJson.version })` with the self-referencing `@mailwoman/nominatim/package.json` JSON import; `NominatimAppOptions.cors` carries the full #1017 rationale from the old options type.

- [ ] **Step 3: Port `nominatim/index.test.ts`** to `app.request()` (all 13 carry over) and ADD pinning tests (exact code):

```ts
test("/status without an engine method answers 200 OK, not 501 (the one non-501 absent-method default)", async () => {
	const app = createNominatimApp({})
	const res = await app.request("/status")
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ status: 0, message: "OK" })
})

test("absent engine methods answer the exact issue-ref 501 bodies", async () => {
	const app = createNominatimApp({})

	for (const [path, message] of [
		["/search?q=berlin", "search not implemented (see #802)"],
		["/reverse?lat=52.5&lon=13.4", "reverse not implemented (see #803)"],
		["/lookup?osm_ids=N1", "lookup not implemented (see #805)"],
	] as const) {
		const res = await app.request(path)
		expect(res.status).toBe(501)
		expect(await res.json()).toEqual({ error: message })
	}
})

test("unknown format falls back to jsonv2 (raw results array)", async () => {
	const app = createNominatimApp({ search: async () => [] })
	const res = await app.request("/search?q=berlin&format=xml")
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual([])
})

test("format=jsonld forces addressdetails on search and reverse, but plain parseBool governs lookup", async () => {
	const seen: Array<boolean | undefined> = []
	const app = createNominatimApp({
		search: async (p) => {
			seen.push(p.addressdetails)

			return []
		},
		reverse: async (p) => {
			seen.push(p.addressdetails)

			return null
		},
		lookup: async (p) => {
			seen.push(p.addressdetails)

			return []
		},
	})

	await app.request("/search?q=x&format=jsonld")
	await app.request("/reverse?lat=1&lon=1&format=jsonld")
	await app.request("/lookup?osm_ids=N1&format=jsonld")
	expect(seen).toEqual([true, true, false])
})

test("reverse with a null engine result serializes null (jsonv2) and an empty FeatureCollection (geojson)", async () => {
	const app = createNominatimApp({ reverse: async () => null })

	const plain = await app.request("/reverse?lat=52.5&lon=13.4")
	expect(plain.status).toBe(200)
	expect(await plain.json()).toBeNull()

	const geo = await app.request("/reverse?lat=52.5&lon=13.4&format=geojson")
	expect(await geo.json()).toEqual({ type: "FeatureCollection", features: [] })
})

test("lookup has no jsonld branch — format=jsonld returns the raw results (legacy quirk preserved)", async () => {
	const results = [{ place_id: 1, licence: "L", lat: "1", lon: "2", display_name: "X" }]
	const app = createNominatimApp({ lookup: async () => results })
	const res = await app.request("/lookup?osm_ids=N1&format=jsonld")
	expect(await res.json()).toEqual(results)
})

test("repeated single-valued params are treated as absent (asString(array) → undefined; never a 400)", async () => {
	let seen: NominatimSearchParams | undefined
	const app = createNominatimApp({
		search: async (p) => {
			seen = p

			return []
		},
	})
	const res = await app.request("/search?q=berlin&q=paris&limit=5")
	expect(res.status).toBe(200)
	expect(seen?.q).toBeUndefined()
	expect(seen?.limit).toBe(5)
})

test("countrycodes and osm_ids comma-split; limit defaults to 10 on absent/invalid", async () => {
	const seenSearch: NominatimSearchParams[] = []
	const seenLookup: NominatimLookupParams[] = []
	const app = createNominatimApp({
		search: async (p) => {
			seenSearch.push(p)

			return []
		},
		lookup: async (p) => {
			seenLookup.push(p)

			return []
		},
	})

	await app.request("/search?q=x&countrycodes=de,fr")
	await app.request("/search?q=x&limit=abc")
	await app.request("/lookup?osm_ids=N1,W2,R3")
	expect(seenSearch[0]?.countrycodes).toEqual(["de", "fr"])
	expect(seenSearch[1]?.limit).toBe(10)
	expect(seenLookup[0]?.osmIds).toEqual(["N1", "W2", "R3"])
})

test("an engine fault answers the clean legacy 500 envelope", async () => {
	const app = createNominatimApp({
		search: async () => {
			throw new Error("resolver exploded")
		},
	})
	const res = await app.request("/search?q=x")
	expect(res.status).toBe(500)
	expect(await res.json()).toEqual({ error: "internal error" })
})

test("GET /openapi.json serves the emitted 3.1 document with all five paths", async () => {
	const app = createNominatimApp({})
	const res = await app.request("/openapi.json")
	const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
	expect(doc.openapi).toBe("3.1.0")
	expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/", "/search", "/reverse", "/lookup", "/status"]))
})
```

- [ ] **Step 4: Gut `index.ts`** (docstring: Hono app, `createNominatimApp`; re-export `./app.ts` + the three Task-1 modules). Drop express dep; `yarn install`.

- [ ] **Step 5: Port `nominatim/cli.ts`** — engine wiring/annotators/#1009 blocks byte-identical; boot swaps `express().use(...).listen(...)` for `createNominatimApp(engine, { cors: values.cors })` + `serveNode({ fetch: app.fetch, port, hostname: host, onListen: () => { …existing banner lines…; endpoints line gains `GET /openapi.json` } })`.

- [ ] **Step 6: Verify + commit**

Run: `yarn vitest run --dir ./nominatim` (13 ported + 10 pinning = 23), `yarn compile`, `yarn oxfmt nominatim`

```bash
git add nominatim yarn.lock
git commit -m "feat(nominatim)!: express Router -> Hono app with emitted OpenAPI document"
```

---

### Task 3: Spec-parity gate — retire the last handwritten yaml

**Files:**

- Create: `nominatim/openapi-parity.test.ts` (temporary, deleted in-task — plan-mandated)
- Delete: `nominatim/openapi.yaml`
- Modify: `nominatim/package.json` (drop `"openapi.yaml"` from `files` if present)

Same three assertions as phases 1–2, WITH the `$ref` dereferencer baked in from the start (phase-2 lesson — the yaml `$ref`-shares `limit`/`addressdetails`/`format`/`accept-language` under `components.parameters`):

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ONE-TIME migration gate (deleted once adjudicated): every legacy path, method, parameter, and
 *   status code must exist in the emitted document. Legacy parameters may be $ref-shared under
 *   components.parameters — dereference before comparing (phase-2 lesson).
 */

import { readFileSync } from "node:fs"

import { emitOpenAPIDocuments } from "@mailwoman/api-kit"
import { expect, test } from "vitest"
import { parse as parseYAML } from "yaml"

import { createNominatimApp } from "./app.ts"

interface ParameterShape {
	name?: string
	$ref?: string
}
interface OperationShape {
	parameters?: ParameterShape[]
	responses: Record<string, unknown>
}
type PathsShape = Record<string, Record<string, OperationShape>>
interface LegacyDoc {
	paths: PathsShape
	components?: { parameters?: Record<string, { name: string }> }
}

const legacy = parseYAML(readFileSync(new URL("./openapi.yaml", import.meta.url), "utf8")) as LegacyDoc

/** Dereference `#/components/parameters/X` to its parameter name. */
function paramName(p: ParameterShape): string {
	if (p.name) return p.name

	const key = p.$ref?.split("/").pop()
	const resolved = key ? legacy.components?.parameters?.[key] : undefined

	if (!resolved) throw new Error(`unresolvable parameter ref: ${p.$ref}`)

	return resolved.name
}

const emitted = emitOpenAPIDocuments(createNominatimApp({}), {
	title: "@mailwoman/nominatim",
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
			const legacyParams = (operation.parameters ?? []).map(paramName).sort()
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

- [ ] **Step 1:** Write the gate; `yarn vitest run --dir ./nominatim --reporter=verbose`; adjudicate every failure (routes-bug → fix; yaml-bug → record). If unclassifiable, STOP/BLOCKED with the exact diff.
- [ ] **Step 2:** Retire: `git rm nominatim/openapi.yaml`; drop the `files` entry if present; `rm` the gate test. Full suite + compile green; `yarn oxfmt nominatim`.
- [ ] **Step 3:** Commit with the full adjudication record in the body (phase-2 commit 6ca49c6f is the model — include record-only observations: required flags, enums, additionalProperties, anything else found).

```bash
git add -A nominatim
git commit -m "feat(nominatim): retire the handwritten OpenAPI yaml — the emitted document is the spec

Parity gate adjudications: <real list>"
```

---

### Task 4: README + CLI reconcile + end-to-end smoke

**Files:** `nominatim/cli.ts` (reconcile — likely no delta; record evidence), `nominatim/README.md`, manual smoke.

- [ ] **Step 1:** Reconcile cli.ts against Task 2 Step 5 (report delta or "no delta" with evidence).
- [ ] **Step 2:** README: swap express/`createNominatimRouter` snippets → `createNominatimApp` + `serveNode` (with `hostname` — phase-2 README lesson); document `GET /openapi.json`; curl examples byte-identical.
- [ ] **Step 3:** Smoke (compile FIRST; kill ONLY the exact `$!` PID — production-incident rule; the hosted nominatim isn't a unit on this host but the rule is absolute):

```bash
yarn compile
node nominatim/out/cli.js serve --port 18080 &
SERVER_PID=$!
sleep 10
curl -s 'http://127.0.0.1:18080/search?q=berlin&format=jsonv2&limit=3' | head -c 400; echo
curl -s 'http://127.0.0.1:18080/search?q=1600+pennsylvania+ave+washington+dc&addressdetails=1' | head -c 500; echo
curl -s 'http://127.0.0.1:18080/search?q=berlin&format=geojson' | head -c 300; echo
curl -s 'http://127.0.0.1:18080/search?q=berlin&format=jsonld' | head -c 300; echo
curl -s 'http://127.0.0.1:18080/reverse?lat=52.52&lon=13.405' | head -c 300; echo
curl -s 'http://127.0.0.1:18080/reverse?lat=91&lon=0'; echo
curl -s 'http://127.0.0.1:18080/status'; echo
curl -s 'http://127.0.0.1:18080/openapi.json' | head -c 200; echo
kill "$SERVER_PID"
```

Expected: results with `licence`/`display_name`/`annotations`; addressdetails carries house_number+road; geojson envelope; jsonld array; reverse hit for Berlin; `{"error":"lat must be in [-90, 90] and lon in [-180, 180]"}`; `{"status":0,"message":"OK"}`; `{"openapi":"3.1.0"`.

- [ ] **Step 4:** `yarn vitest run --dir ./nominatim` green; `yarn oxfmt nominatim`; commit `feat(nominatim): serve via api-kit serveNode; emitted OpenAPI at /openapi.json`.

---

### Task 5: Repo-wide green + branch wrap

- [ ] **Step 1:** `rm -rf nominatim/out api-kit/out && yarn compile` — clean.
- [ ] **Step 2:** `yarn vitest run --dir ./nominatim`; `yarn vitest run --dir ./api-kit`; `yarn test:integration`.
- [ ] **Step 3:** `node scripts/smoke-clean-install.ts` — the publish-safety receipt.
- [ ] **Step 4:** `yarn lint:oxlint`; `yarn oxfmt --check nominatim`.
- [ ] **Step 5:** `grep -rn "express" nominatim --include="*.ts" --include="*.json" | grep -v out/` — no live hits.
- [ ] **Step 6:** Docs: `docs/articles/api.mdx` — the "source of truth" passage and redocly example now have NO surviving checked-in yaml; rewrite that passage: all three drop-ins emit their documents at `GET /openapi.json`; drop the redocly-lint example or repoint it at an emitted document workflow (`curl …/openapi.json | npx @redocly/cli lint -`). Own commit: `docs: all drop-in specs are emitted at /openapi.json`.
- [ ] **Step 7:** Push + PR:

```bash
git push -u origin feat/hono-nominatim
gh pr create --title "feat!: Hono API surface, phase 3 — nominatim migration" --body "<spec/plan links; pattern reuse note (legacyQuery, tolerant unions — photon precedent); the four nominatim wrinkles pinned (/status default, issue-ref 501s, format fallback, addressdetails forcing + lookup quirk); parity adjudications; smoke receipts; breaking note (createNominatimRouter removed, no shim); registerNominatimRoutes exported for phase 4. End with the Claude Code attribution line.>"
```

Controller then runs the final whole-branch review before merge (standing operator grant: merge when tests pass).

---

## Deferred (per spec §Order)

- **Phase 4 (native API)**: `@mailwoman/api`, api-kit error envelope + metrics port, `mailwoman serve` (needs `registerXRoutes` root exports on libpostal + photon — nominatim's lands here), delete `mailwoman/server` + express repo-wide, graceful shutdown.
- **Phase 5 (CI clients)**: spec artifacts in release workflow, Python/Rust generation, `feat/api-clients` closure, docs follow-up (orphaned static yamls — now three — + api.mdx table rows; jsonld oneOf doc accuracy).
