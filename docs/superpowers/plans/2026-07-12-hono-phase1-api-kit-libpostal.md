# Hono API surface, Phase 1: `@mailwoman/api-kit` + libpostal migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `@mailwoman/api-kit` plumbing workspace and migrate `@mailwoman/libpostal` from express to Hono + `@hono/zod-openapi`, with the OpenAPI document emitted from the route table and the handwritten `libpostal/openapi.yaml` retired through a spec-parity gate.

**Architecture:** Per the approved spec (`docs/superpowers/specs/2026-07-12-hono-api-surface-design.md`): code-first, one direction — Zod schemas next to routes, spec emitted, never handwritten. libpostal is the pattern-prover (smallest drop-in). api-kit ships **only what libpostal consumes** in this phase (node serve wrapper + doc-emit helpers); the error envelope, GeoJSON atoms, and metrics hooks land in later phases with their first consumers (photon / native API). Deliberate deferral, not a gap.

**Tech Stack:** hono `^4.12.29`, `@hono/zod-openapi` `^1.4.0` (re-exports Zod 4 as `z` with `.openapi()` metadata), `@hono/node-server` `^2.0.8`, zod `^4.4.3` (already used by `core`/`mailwoman`), vitest.

## Global Constraints

- **Vendor wire shapes are immutable**: response bodies, error bodies (`{ "error": "query is required" }` etc.), status codes (200/400/500/501), and CORS header behavior must match `libpostal/index.ts` on main exactly. The engine interface (`LibpostalEngine`, `ParseMatch`) is public API and must not change.
- **No express shims**: `createLibpostalRouter` is deleted, not deprecated (operator decision 2026-07-12 — vendor wire compat is the only legacy binding). Rides the next-major train.
- `erasableSyntaxOnly` — no `enum`, no constructor parameter properties. Relative imports carry explicit `.ts` extensions; `rewriteRelativeImportExtensions` handles `out/`.
- **Both exports maps** on every touched `package.json`: dev map (`node` → `.ts` first) AND `publishConfig.exports` (no `node` condition). A subpath in only one map is a release bug.
- Acronym casing: whole camelCase components — `attachOpenAPIDocs`, `emitOpenAPIDocuments`, never `attachOpenApiDocs`.
- No raw `process.env`/`process.argv` (CI-enforced oxlint rule). `node:util` `parseArgs` is the existing CLI pattern — keep it.
- Compile before running anything against `out/` — stale `out/` lies. Format with `yarn oxfmt <file>` before committing (pre-commit hook checks staged files).
- Run repo commands from the repo root. Plain `node` runs `.ts` source directly.

---

### Task 1: Scaffold the `@mailwoman/api-kit` workspace

**Files:**

- Create: `api-kit/package.json`
- Create: `api-kit/tsconfig.json`
- Create: `api-kit/index.ts`
- Modify: `package.json` (root — workspaces array, ~line 18)
- Modify: `tsconfig.json` (root — references array, ~line 48)

**Interfaces:**

- Consumes: nothing (leaf scaffold).
- Produces: the `@mailwoman/api-kit` workspace resolving from sibling packages; `api-kit/index.ts` re-exporting `./serve.ts` and `./openapi.ts` (files arrive in Task 2 — index starts empty of exports but must exist for the exports map to typecheck).

- [ ] **Step 1: Create `api-kit/package.json`**

```json
{
	"name": "@mailwoman/api-kit",
	"version": "5.10.1",
	"description": "API plumbing for Mailwoman's HTTP surfaces — Hono node serve wrapper, OpenAPI emit helpers, shared wire atoms. Plumbing only: domain schemas live with their routes.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"repository": {
		"type": "git",
		"url": "https://github.com/sister-software/mailwoman.git",
		"directory": "api-kit"
	},
	"files": ["out/**/*.js", "out/**/*.js.map", "out/**/*.d.ts", "out/**/*.d.ts.map", "README.md"],
	"type": "module",
	"exports": {
		"./package.json": "./package.json",
		".": {
			"node": "./index.ts",
			"default": "./out/index.js",
			"types": "./out/index.d.ts"
		}
	},
	"publishConfig": {
		"access": "public"
	},
	"dependencies": {
		"@hono/node-server": "^2.0.8",
		"@hono/zod-openapi": "^1.4.0",
		"hono": "^4.12.29",
		"zod": "^4.4.3"
	}
}
```

- [ ] **Step 2: Create `api-kit/tsconfig.json`** (mirrors `annotations/tsconfig.json` exactly)

```json
{
	"extends": "@sister.software/tsconfig",
	"compilerOptions": {
		"outDir": "./out",
		"emitDeclarationOnly": false,
		"rewriteRelativeImportExtensions": true,
		"erasableSyntaxOnly": true
	},
	"include": ["./**/*"],
	"exclude": ["./out/**/*", "./**/*.test.ts", "./**/*.test.tsx"],
	"references": []
}
```

- [ ] **Step 3: Create `api-kit/index.ts`** (placeholder header; exports arrive in Task 2)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/api-kit` — plumbing for Mailwoman's HTTP surfaces: the node serve wrapper and
 *   OpenAPI emit helpers. Plumbing only, by rule: domain schemas live next to their routes in the
 *   package that owns the wire contract (see the 2026-07-12 design spec's anti-meta guardrails).
 */

export {}
```

- [ ] **Step 4: Register the workspace.** In root `package.json`, add `"api-kit",` to the `workspaces` array immediately after `"annotations",` (~line 19). In root `tsconfig.json`, add `{ "path": "./api-kit" },` immediately after the `{ "path": "./annotations" },` reference (~line 48).

- [ ] **Step 5: Install + verify resolution**

Run: `yarn install`
Expected: lockfile gains hono/@hono/zod-openapi/@hono/node-server entries, no resolution errors.

Run: `node -e 'import("@hono/zod-openapi").then((m) => console.log(typeof m.OpenAPIHono))'` from `api-kit/`
Expected: `function`

- [ ] **Step 6: Confirm the `@hono/node-server` v2 `serve` signature.** Read `node_modules/@hono/node-server/dist/index.d.ts`. Task 2's wrapper assumes `serve(options: { fetch, port, hostname }, listeningListener?: (info: AddressInfo) => void): ServerType`. If v2 renamed options or the return type, adjust Task 2's code to the actual signature — the wrapper's own exported interface (`serveNode(options: ServeNodeOptions)`) stays as written.

- [ ] **Step 7: Compile + commit**

Run: `yarn compile`
Expected: clean (api-kit emits `out/index.js`).

```bash
git add api-kit package.json tsconfig.json yarn.lock
git commit -m "feat(api-kit): scaffold the @mailwoman/api-kit workspace"
```

---

### Task 2: api-kit `serveNode()` + OpenAPI doc helpers

**Files:**

- Create: `api-kit/serve.ts`
- Create: `api-kit/openapi.ts`
- Create: `api-kit/index.test.ts`
- Modify: `api-kit/index.ts`

**Interfaces:**

- Consumes: `@hono/node-server` `serve`, `@hono/zod-openapi` `OpenAPIHono`.
- Produces (later tasks and phases import these from `@mailwoman/api-kit`):
  - `serveNode(options: ServeNodeOptions): ServerHandle` where `ServeNodeOptions = { fetch: FetchLike; port: number; hostname: string; onListen?: (info: { port: number; address: string }) => void }` and `ServerHandle = { close(): Promise<void> }`.
  - `attachOpenAPIDocs(app: OpenAPIHono, info: OpenAPIDocInfo, path?: string): void` — mounts the 3.1 document at `path` (default `"/openapi.json"`).
  - `emitOpenAPIDocuments(app: OpenAPIHono, info: OpenAPIDocInfo): { v31: object; v30: object }` — programmatic emit, both flavors (3.0 exists for client generators; kills `downgrade-spec.py` in the CI phase).
  - `OpenAPIDocInfo = { title: string; version: string; description?: string }`.

- [ ] **Step 1: Write the failing tests** (`api-kit/index.test.ts`)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { expect, test } from "vitest"

import { attachOpenAPIDocs, emitOpenAPIDocuments, serveNode } from "./index.ts"

/** A minimal one-route app shared by the doc + serve tests. */
function createPingApp(): OpenAPIHono {
	const app = new OpenAPIHono()

	app.openapi(
		createRoute({
			method: "get",
			path: "/ping",
			responses: {
				200: {
					description: "pong",
					content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
				},
			},
		}),
		(c) => c.json({ ok: true }, 200)
	)

	return app
}

const info = { title: "@mailwoman/api-kit test", version: "0.0.0" }

test("attachOpenAPIDocs: mounts a 3.1 document at /openapi.json", async () => {
	const app = createPingApp()
	attachOpenAPIDocs(app, info)

	const res = await app.request("/openapi.json")
	expect(res.status).toBe(200)
	const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
	expect(doc.openapi).toBe("3.1.0")
	expect(Object.keys(doc.paths)).toContain("/ping")
})

test("emitOpenAPIDocuments: returns both 3.1 and 3.0 flavors from the same route table", () => {
	const app = createPingApp()
	const { v31, v30 } = emitOpenAPIDocuments(app, info)

	expect((v31 as { openapi: string }).openapi).toBe("3.1.0")
	expect((v30 as { openapi: string }).openapi).toBe("3.0.3")
	expect(Object.keys((v31 as { paths: object }).paths)).toContain("/ping")
	expect(Object.keys((v30 as { paths: object }).paths)).toContain("/ping")
})

test("serveNode: binds, answers over real HTTP, closes cleanly", async () => {
	const app = createPingApp()
	let bound = 0
	const server = serveNode({
		fetch: app.fetch,
		port: 0, // ephemeral
		hostname: "127.0.0.1",
		onListen: (i) => {
			bound = i.port
		},
	})

	try {
		expect(bound).toBeGreaterThan(0)
		const res = await fetch(`http://127.0.0.1:${bound}/ping`)
		expect(await res.json()).toEqual({ ok: true })
	} finally {
		await server.close()
	}
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run --dir ./api-kit`
Expected: FAIL — `attachOpenAPIDocs` (etc.) have no exported member.

- [ ] **Step 3: Implement `api-kit/openapi.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OpenAPI emit helpers. The document is always derived from the route table — never
 *   handwritten. 3.1 is the published flavor; 3.0 exists solely for client generators that lag
 *   (progenitor), replacing the old hand-downgrade step.
 */

import type { OpenAPIHono } from "@hono/zod-openapi"

/** The `info` block stamped into emitted documents. */
export interface OpenAPIDocInfo {
	title: string
	version: string
	description?: string
}

/** Mount the OpenAPI 3.1 document endpoint on `app` (default `/openapi.json`). */
export function attachOpenAPIDocs(app: OpenAPIHono, info: OpenAPIDocInfo, path = "/openapi.json"): void {
	app.doc31(path, { openapi: "3.1.0", info })
}

/** Emit both document flavors programmatically (build artifacts, parity tests, client generation). */
export function emitOpenAPIDocuments(app: OpenAPIHono, info: OpenAPIDocInfo): { v31: object; v30: object } {
	return {
		v31: app.getOpenAPI31Document({ openapi: "3.1.0", info }),
		v30: app.getOpenAPIDocument({ openapi: "3.0.3", info }),
	}
}
```

- [ ] **Step 4: Implement `api-kit/serve.ts`** (adjust internals to the signature confirmed in Task 1 Step 6 if needed; the exported interface is fixed)

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node serve wrapper over `@hono/node-server`. The one place the node listener is created —
 *   surface packages stay web-standard (they only export `fetch`-shaped apps) so an edge
 *   deployment needs no changes to them.
 */

import { serve } from "@hono/node-server"

/** A `fetch`-shaped request handler (what `OpenAPIHono.fetch` provides). */
export type FetchLike = (request: Request, ...args: never[]) => Response | Promise<Response>

export interface ServeNodeOptions {
	fetch: FetchLike
	port: number
	hostname: string
	/** Called once the listener is bound — receives the actual port (useful with `port: 0`). */
	onListen?: (info: { port: number; address: string }) => void
}

export interface ServerHandle {
	close(): Promise<void>
}

/** Boot a node HTTP listener for a Hono app. Returns a handle whose `close()` resolves when the listener is down. */
export function serveNode(options: ServeNodeOptions): ServerHandle {
	const server = serve({ fetch: options.fetch as never, port: options.port, hostname: options.hostname }, (info) =>
		options.onListen?.({ port: info.port, address: info.address })
	)

	return {
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error?: Error) => (error ? reject(error) : resolve()))
			}),
	}
}
```

- [ ] **Step 5: Re-export from `api-kit/index.ts`** (replace the `export {}` placeholder)

```ts
export * from "./openapi.ts"
export * from "./serve.ts"
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn vitest run --dir ./api-kit`
Expected: 3 passed.

- [ ] **Step 7: Compile + commit**

Run: `yarn compile`
Expected: clean.

```bash
git add api-kit
git commit -m "feat(api-kit): serveNode wrapper + OpenAPI doc emit helpers"
```

---

### Task 3: Split libpostal's engine + schemas out of `index.ts`

**Files:**

- Create: `libpostal/engine.ts`
- Create: `libpostal/schema.ts`
- Modify: `libpostal/index.ts`
- Test: `libpostal/index.test.ts` (existing — must stay green through this task)

**Interfaces:**

- Consumes: `z` from `@hono/zod-openapi` (dep added in Task 4 Step 1 — add it now if running tasks strictly in order: `"@hono/zod-openapi": "^1.4.0"` in `libpostal/package.json` dependencies, then `yarn install`).
- Produces:
  - `libpostal/engine.ts`: `LibpostalComponent`, `ParseMatch`, `COMPONENT_TO_LIBPOSTAL`, `toLibpostalComponents(matches: ParseMatch[]): LibpostalComponent[]`, `LibpostalEngine` — **moved verbatim from `index.ts`, zero signature changes** (public API).
  - `libpostal/schema.ts`: `ParseRequestSchema`, `ExpandRequestSchema`, `LibpostalComponentSchema`, `ParseResponseSchema`, `ExpandResponseSchema`, `ErrorSchema` (exact names — Task 4 imports them). Query-parameter schemas live in `routes.ts` beside their routes — they're route metadata, not reusable wire shapes.

- [ ] **Step 1: Move the engine block.** Cut `LibpostalComponent`, `ParseMatch`, `COMPONENT_TO_LIBPOSTAL`, `toLibpostalComponents`, and `LibpostalEngine` (lines ~18–66 of `libpostal/index.ts`) verbatim into new `libpostal/engine.ts` with the standard copyright header and the docstring: engine contract + the `ComponentTag` → libpostal-label mapping (libpostal-specific knowledge lives here; the engine yields raw Mailwoman matches).

- [ ] **Step 2: Write `libpostal/schema.ts`**

Wire-shape notes carried from the express implementation (immutable):

- `query`/`address` are **optional at the schema layer**; the handler enforces presence so the 400 body is exactly `{ "error": "query is required" }` / `{ "error": "address is required" }` — never a Zod-shaped validation error.
- Objects use Zod's default strip mode, **not** `.strict()` — express tolerated extra keys (the old yaml's `additionalProperties: false` overpromised; adjudicated in Task 5).

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Zod wire schemas for the libpostal-compatible surface. Key names and error bodies are the
 *   vendor contract — immutable. Presence of `query`/`address` is enforced in the handlers (not
 *   the schemas) so validation failures keep libpostal's exact `{ error: "…" }` shape.
 */

import { z } from "@hono/zod-openapi"

/** `POST /parse` JSON body — `address` is accepted as an alias for `query`. */
export const ParseRequestSchema = z
	.object({
		query: z.string().optional(),
		address: z.string().optional(),
	})
	.openapi("ParseRequest")

/** `POST /expand` JSON body. */
export const ExpandRequestSchema = z
	.object({
		address: z.string().optional(),
	})
	.openapi("ExpandRequest")

/** A libpostal `parse_address` component — label + covered text, in order. */
export const LibpostalComponentSchema = z
	.object({
		label: z.string(),
		value: z.string(),
	})
	.openapi("LibpostalComponent")

export const ParseResponseSchema = z.array(LibpostalComponentSchema)

export const ExpandResponseSchema = z
	.object({
		expansions: z.array(z.string()),
	})
	.openapi("ExpandResponse")

/** libpostal's JSON error envelope. */
export const ErrorSchema = z
	.object({
		error: z.string(),
	})
	.openapi("Error")
```

- [ ] **Step 3: Re-export from `index.ts`.** In `libpostal/index.ts`, delete the moved block and add `export * from "./engine.ts"` and `export * from "./schema.ts"` above the remaining express code (which Task 4 deletes). Keep the express router compiling for now — this task is a pure move.

- [ ] **Step 4: Run the existing tests**

Run: `yarn vitest run --dir ./libpostal`
Expected: all 7 existing tests PASS unchanged (they import via `./index.ts`, which still re-exports everything).

- [ ] **Step 5: Commit**

```bash
git add libpostal
git commit -m "refactor(libpostal): split engine contract + zod wire schemas out of index.ts"
```

---

### Task 4: libpostal routes + app on Hono; port the test suite

**Files:**

- Create: `libpostal/routes.ts`
- Create: `libpostal/app.ts`
- Modify: `libpostal/index.ts` (delete all express code; re-export `./app.ts`)
- Modify: `libpostal/package.json` (swap deps)
- Modify: `libpostal/index.test.ts` (port to `app.request()`)

**Interfaces:**

- Consumes: Task 2's `attachOpenAPIDocs`; Task 3's engine + schema exports.
- Produces:
  - `createLibpostalApp(engine: LibpostalEngine, options?: LibpostalAppOptions): OpenAPIHono` where `LibpostalAppOptions = { cors?: boolean }` (same semantics as the old `LibpostalRouterOptions.cors`, default true).
  - `registerLibpostalRoutes(app: OpenAPIHono, engine: LibpostalEngine): void` (exported for composition — phase 4's `mailwoman serve` mounts surfaces onto one app).
  - `createLibpostalRouter` and `LibpostalRouterOptions` **no longer exist** — breaking, by decision.

- [ ] **Step 1: Update `libpostal/package.json`.** Dependencies become:

```json
	"dependencies": {
		"@hono/zod-openapi": "^1.4.0",
		"@mailwoman/api-kit": "workspace:*",
		"@mailwoman/normalize": "workspace:*",
		"hono": "^4.12.29",
		"mailwoman": "workspace:*"
	}
```

(`express` removed.) Run `yarn install`.

- [ ] **Step 2: Port the test file.** Rewrite `libpostal/index.test.ts`: keep the three engine-mapping tests verbatim (their import path is unchanged); replace the express `withServer` harness — Hono apps answer `app.request()` directly, no listener. Add the wire-parity and new-capability tests:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	COMPONENT_TO_LIBPOSTAL,
	createLibpostalApp,
	type LibpostalEngine,
	type ParseMatch,
	toLibpostalComponents,
} from "./index.ts"

test("toLibpostalComponents: maps our classifications to libpostal labels, in order", () => {
	const matches: ParseMatch[] = [
		{ classification: "house_number", value: "1600" },
		{ classification: "street", value: "Pennsylvania Ave NW" },
		{ classification: "locality", value: "Washington" },
		{ classification: "region", value: "DC" },
		{ classification: "postcode", value: "20500" },
	]
	expect(toLibpostalComponents(matches)).toEqual([
		{ label: "house_number", value: "1600" },
		{ label: "road", value: "Pennsylvania Ave NW" },
		{ label: "city", value: "Washington" },
		{ label: "state", value: "DC" },
		{ label: "postcode", value: "20500" },
	])
})

test("toLibpostalComponents: passes unmapped classifications through unchanged", () => {
	expect(toLibpostalComponents([{ classification: "some_future_tag", value: "x" }])).toEqual([
		{ label: "some_future_tag", value: "x" },
	])
})

test("COMPONENT_TO_LIBPOSTAL: the core US/EU mappings hold", () => {
	expect(COMPONENT_TO_LIBPOSTAL.street).toBe("road")
	expect(COMPONENT_TO_LIBPOSTAL.locality).toBe("city")
	expect(COMPONENT_TO_LIBPOSTAL.region).toBe("state")
	expect(COMPONENT_TO_LIBPOSTAL.postcode).toBe("postcode")
})

/** An engine that parses "1600 pennsylvania ave" into two fixed matches; no expand. */
const fixtureEngine: LibpostalEngine = {
	parse: async () => [
		{ classification: "house_number", value: "1600" },
		{ classification: "street", value: "pennsylvania ave" },
	],
}

const expandingEngine: LibpostalEngine = {
	...fixtureEngine,
	expand: async (address) => [address, `${address} expanded`],
}

test("GET /parse?query= returns ordered libpostal components", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/parse?query=1600+pennsylvania+ave")
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual([
		{ label: "house_number", value: "1600" },
		{ label: "road", value: "pennsylvania ave" },
	])
})

test("GET /parse honors the address alias", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/parse?address=1600+pennsylvania+ave")
	expect(res.status).toBe(200)
})

test("POST /parse accepts a JSON body (native now — the express CLI never mounted a body parser)", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/parse", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: "1600 pennsylvania ave" }),
	})
	expect(res.status).toBe(200)
	expect(((await res.json()) as unknown[]).length).toBe(2)
})

test("parse without a query answers the exact legacy 400 body", async () => {
	const app = createLibpostalApp(fixtureEngine)

	for (const res of [
		await app.request("/parse"),
		await app.request("/parse", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		}),
	]) {
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ error: "query is required" })
	}
})

test("expand without an engine method answers the exact legacy 501 body", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/expand?address=x")
	expect(res.status).toBe(501)
	expect(await res.json()).toEqual({ error: "expand not implemented" })
})

test("expand with an engine: 200 with expansions; missing address is the legacy 400", async () => {
	const app = createLibpostalApp(expandingEngine)

	const ok = await app.request("/expand?address=1600+penn")
	expect(ok.status).toBe(200)
	expect(await ok.json()).toEqual({ expansions: ["1600 penn", "1600 penn expanded"] })

	const missing = await app.request("/expand")
	expect(missing.status).toBe(400)
	expect(await missing.json()).toEqual({ error: "address is required" })
})

test("an engine fault answers the clean legacy 500, never a crash", async () => {
	const app = createLibpostalApp({
		parse: async () => {
			throw new Error("model exploded")
		},
	})
	const res = await app.request("/parse?query=x")
	expect(res.status).toBe(500)
	expect(await res.json()).toEqual({ error: "internal error" })
})

test("CORS: permissive Access-Control-Allow-Origin on responses (browser clients)", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/parse?query=x")
	expect(res.headers.get("access-control-allow-origin")).toBe("*")
})

test("CORS: preflight OPTIONS answers 204 with CORS headers (POST /parse is preflighted)", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/parse", {
		method: "OPTIONS",
		headers: { origin: "https://example.com", "access-control-request-method": "POST" },
	})
	expect(res.status).toBe(204)
	expect(res.headers.get("access-control-allow-origin")).toBe("*")
	expect(res.headers.get("access-control-allow-methods")).toContain("POST")
})

test("CORS: { cors: false } disables the headers (for a proxy that owns CORS)", async () => {
	const app = createLibpostalApp(fixtureEngine, { cors: false })
	const res = await app.request("/parse?query=x")
	expect(res.headers.get("access-control-allow-origin")).toBeNull()
})

test("root: GET / serves a friendly HTML banner, not a bare 404 (#1022)", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/")
	expect(res.status).toBe(200)
	expect(res.headers.get("content-type")).toContain("text/html")
	const body = await res.text()
	expect(body).toContain("@mailwoman/libpostal")
	expect(body).toContain("/parse?query=")
	expect(body).toContain("switching-from-libpostal")
})

test("GET /openapi.json serves the emitted 3.1 document", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/openapi.json")
	expect(res.status).toBe(200)
	const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
	expect(doc.openapi).toBe("3.1.0")
	expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/", "/parse", "/expand"]))
})
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `yarn vitest run --dir ./libpostal`
Expected: FAIL — `createLibpostalApp` is not exported.

- [ ] **Step 4: Implement `libpostal/routes.ts`**

Handler rules (wire parity): trim inputs; `body.query ?? query.query ?? body.address ?? query.address` precedence for `/parse`; presence enforced in-handler for the exact legacy 400 bodies; malformed/missing JSON on POST must fall through to the 400 (catch `c.req.json()` failures — do not let Hono's body parsing produce its own error shape).

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route definitions + handlers for the libpostal-compatible surface. The OpenAPI document is
 *   emitted from these definitions — there is no handwritten spec. Wire shapes (bodies, error
 *   envelopes, status codes) are the vendor contract; see schema.ts.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"

import { type LibpostalEngine, toLibpostalComponents } from "./engine.ts"
import {
	ErrorSchema,
	ExpandRequestSchema,
	ExpandResponseSchema,
	ParseRequestSchema,
	ParseResponseSchema,
} from "./schema.ts"

/**
 * A friendly HTML landing page for `GET /` (#1022). libpostal's own REST server has no root page,
 * so there's no wire contract to match — pure courtesy for browser visitors. Relative example URLs
 * so they resolve against whatever host/port serves this.
 */
const ROOT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@mailwoman/libpostal</title>
<style>
:root { color-scheme: light dark }
body { font: 16px/1.6 system-ui, -apple-system, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem }
h1 { font-size: 1.3rem; margin: 0 0 .5rem }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
ul { padding-left: 1.2rem }
li { margin: .4rem 0 }
a { color: #2563eb }
.q { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
footer { margin-top: 2rem; font-size: .9rem; opacity: .8 }
</style>
</head>
<body>
<h1>@mailwoman/libpostal</h1>
<p>A libpostal-compatible <code>/parse</code> and <code>/expand</code> API, backed by a calibrated neural address parser (<code>POST</code> a JSON body, or <code>GET</code> with a query param).</p>
<p>Try a query:</p>
<ul>
<li><a class="q" href="/parse?query=1600+pennsylvania+ave+washington+dc">/parse?query=1600+pennsylvania+ave+washington+dc</a></li>
<li><a class="q" href="/parse?query=berlin+germany">/parse?query=berlin+germany</a></li>
<li><a class="q" href="/expand?address=1600+pennsylvania+ave+nw">/expand?address=1600+pennsylvania+ave+nw</a></li>
</ul>
<footer><a href="https://mailwoman.sister.software/docs/concepts/switching-from-libpostal">Switching from libpostal</a> &middot; <a href="https://mailwoman.sister.software/demo">Live demo</a></footer>
</body>
</html>
`

const errorContent = (description: string) => ({
	description,
	content: { "application/json": { schema: ErrorSchema } },
})

/** Query-side request schema, shared by the GET routes (documented; presence enforced in-handler). */
const parseQueryParams = z.object({
	query: z.string().optional().openapi({ description: "The address to parse. `address` is accepted as an alias." }),
	address: z.string().optional().openapi({ description: "Alias for `query`." }),
})

const expandQueryParams = z.object({
	address: z.string().optional().openapi({ description: "The address to expand." }),
})

const parseResponses = {
	200: {
		description: "The ordered libpostal components.",
		content: { "application/json": { schema: ParseResponseSchema } },
	},
	400: errorContent("The required `query` (or `address`) parameter is missing."),
	500: errorContent("An unexpected engine fault. A clean JSON error, never a stack trace."),
}

const expandResponses = {
	200: {
		description: "The deterministic expansion set.",
		content: { "application/json": { schema: ExpandResponseSchema } },
	},
	400: errorContent("The required `address` parameter is missing."),
	500: errorContent("An unexpected engine fault. A clean JSON error, never a stack trace."),
	501: errorContent("The backing engine method is not wired for this deployment."),
}

const rootRoute = createRoute({
	method: "get",
	path: "/",
	operationId: "getRoot",
	summary: "Landing page",
	tags: ["meta"],
	responses: {
		200: { description: "HTML landing page.", content: { "text/html": { schema: z.string() } } },
	},
})

const parseGetRoute = createRoute({
	method: "get",
	path: "/parse",
	operationId: "parseGet",
	summary: "Parse an address (query string)",
	tags: ["parsing"],
	request: { query: parseQueryParams },
	responses: parseResponses,
})

const parsePostRoute = createRoute({
	method: "post",
	path: "/parse",
	operationId: "parsePost",
	summary: "Parse an address (JSON body)",
	tags: ["parsing"],
	request: {
		body: { content: { "application/json": { schema: ParseRequestSchema } }, required: false },
	},
	responses: parseResponses,
})

const expandGetRoute = createRoute({
	method: "get",
	path: "/expand",
	operationId: "expandGet",
	summary: "Expand an address (query string)",
	tags: ["parsing"],
	request: { query: expandQueryParams },
	responses: expandResponses,
})

const expandPostRoute = createRoute({
	method: "post",
	path: "/expand",
	operationId: "expandPost",
	summary: "Expand an address (JSON body)",
	tags: ["parsing"],
	request: {
		body: { content: { "application/json": { schema: ExpandRequestSchema } }, required: false },
	},
	responses: expandResponses,
})

/** Read the JSON body if present and parseable; a missing/malformed body is `{}` (legacy tolerance). */
async function readBody(c: Context): Promise<Record<string, unknown>> {
	try {
		const body = (await c.req.json()) as unknown

		return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

const asTrimmedString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined

/** Register the libpostal-compatible routes against an injected engine. */
export function registerLibpostalRoutes(app: OpenAPIHono, engine: LibpostalEngine): void {
	app.openapi(rootRoute, (c) => c.html(ROOT_HTML))

	const parse = async (c: Context, body: Record<string, unknown>) => {
		const query =
			asTrimmedString(body.query) ??
			asTrimmedString(c.req.query("query")) ??
			asTrimmedString(body.address) ??
			asTrimmedString(c.req.query("address"))

		if (!query) return c.json({ error: "query is required" }, 400)

		return c.json(toLibpostalComponents(await engine.parse(query)), 200)
	}

	const expand = async (c: Context, body: Record<string, unknown>) => {
		if (!engine.expand) return c.json({ error: "expand not implemented" }, 501)

		const address = asTrimmedString(body.address) ?? asTrimmedString(c.req.query("address"))

		if (!address) return c.json({ error: "address is required" }, 400)

		return c.json({ expansions: await engine.expand(address) }, 200)
	}

	app.openapi(parseGetRoute, (c) => parse(c, {}))
	app.openapi(parsePostRoute, async (c) => parse(c, await readBody(c)))
	app.openapi(expandGetRoute, (c) => expand(c, {}))
	app.openapi(expandPostRoute, async (c) => expand(c, await readBody(c)))
}
```

Note: handlers read params via `c.req.query()` / `readBody()` rather than `c.req.valid()` — every field is optional at the schema layer (validation cannot fail), and this keeps body precedence and the exact legacy 400 bodies in one visible place. The schemas still drive the emitted document. If `app.openapi`'s handler typing rejects the plain-`Context` handlers, type the handlers as the route's handler type or loosen with a local cast — do not change the wire behavior to satisfy types.

- [ ] **Step 5: Implement `libpostal/app.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The libpostal-compatible Hono app: CORS + error safety net + routes + the emitted OpenAPI
 *   document. Engine-agnostic — the CLI wires the real parser; tests inject fixtures.
 */

import { OpenAPIHono } from "@hono/zod-openapi"
import { attachOpenAPIDocs } from "@mailwoman/api-kit"
import { cors } from "hono/cors"

import packageJson from "@mailwoman/libpostal/package.json" with { type: "json" }

import type { LibpostalEngine } from "./engine.ts"
import { registerLibpostalRoutes } from "./routes.ts"

/** Options for {@link createLibpostalApp}. */
export interface LibpostalAppOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer
	 * preflight `OPTIONS` with `204`. Default `true` — browser clients need it (#1017). Set `false`
	 * when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean
}

/** Build the libpostal-compatible app around an injected {@link LibpostalEngine}. */
export function createLibpostalApp(engine: LibpostalEngine, options: LibpostalAppOptions = {}): OpenAPIHono {
	const app = new OpenAPIHono()

	if (options.cors !== false) {
		app.use(cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["*"], maxAge: 86400 }))
	}

	// Safety net: an engine fault returns the clean legacy JSON error, never a crash (wire contract).
	app.onError((_error, c) => c.json({ error: "internal error" }, 500))

	registerLibpostalRoutes(app, engine)
	attachOpenAPIDocs(app, { title: packageJson.name, version: packageJson.version })

	return app
}
```

(The self-referencing `@mailwoman/libpostal/package.json` import resolves through the exports map from both source and `out/` — a relative `../package.json` would break under `out/`. If `tsc` rejects the JSON import attribute, add `"resolveJsonModule": true` to `libpostal/tsconfig.json` `compilerOptions`.)

- [ ] **Step 6: Gut `libpostal/index.ts`.** The file becomes the package docstring (update: "Hono app" replaces "express Router"; `createLibpostalApp` replaces `createLibpostalRouter`) plus:

```ts
export * from "./app.ts"
export * from "./engine.ts"
export * from "./schema.ts"
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `yarn vitest run --dir ./libpostal`
Expected: all tests PASS (3 engine + 12 app).

- [ ] **Step 8: Compile + commit**

Run: `yarn compile`
Expected: clean. If anything else in the repo imported `createLibpostalRouter`, it surfaces here — the only known consumer is `libpostal/cli.ts` (Task 6); fix any stragglers by migrating them to `createLibpostalApp`, not by re-adding the export.

```bash
git add libpostal yarn.lock
git commit -m "feat(libpostal)!: express Router -> Hono app with emitted OpenAPI document"
```

---

### Task 5: Spec-parity gate — emitted document vs the handwritten yaml, then retire the yaml

**Files:**

- Create: `libpostal/openapi-parity.test.ts` (temporary — deleted at the end of this task)
- Delete: `libpostal/openapi.yaml`
- Modify: `libpostal/package.json` (drop `openapi.yaml` from `files`)

**Interfaces:**

- Consumes: `createLibpostalApp` (Task 4), `emitOpenAPIDocuments` (Task 2), the handwritten `libpostal/openapi.yaml` (read via the `yaml` package — already a repo devDependency; if not resolvable from `libpostal/`, add `"yaml": "^2.8.1"` to `libpostal` devDependencies).
- Produces: an adjudication record (in the commit message) and a repo with **no handwritten spec** for libpostal.

- [ ] **Step 1: Write the parity test**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ONE-TIME migration gate (deleted once adjudicated): the emitted OpenAPI document must cover
 *   the handwritten openapi.yaml's contract — every path, method, parameter, and status code.
 *   Differences are either bugs in the new routes or bugs that were always in the yaml.
 */

import { readFileSync } from "node:fs"

import { emitOpenAPIDocuments } from "@mailwoman/api-kit"
import { expect, test } from "vitest"
import { parse as parseYAML } from "yaml"

import { createLibpostalApp } from "./app.ts"

interface OperationShape {
	parameters?: { name: string; required?: boolean }[]
	responses: Record<string, unknown>
}
type PathsShape = Record<string, Record<string, OperationShape>>

const legacy = parseYAML(readFileSync(new URL("./openapi.yaml", import.meta.url), "utf8")) as { paths: PathsShape }

const emitted = emitOpenAPIDocuments(createLibpostalApp({ parse: async () => [] }), {
	title: "@mailwoman/libpostal",
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

- [ ] **Step 2: Run the gate and adjudicate every failure**

Run: `yarn vitest run --dir ./libpostal --reporter=verbose`

Adjudication rules — each difference is exactly one of:

1. **Bug in the new routes** (a path/param/status the express server really served is missing) → fix `routes.ts`, re-run.
2. **Bug that was always in the yaml** (documented something the server never did) → record it in the Step 4 commit message; no code change. Known instance going in: `additionalProperties: false` on request schemas — express tolerated extra keys; the emitted document (strip-mode Zod) is the accurate contract.

Expected end state: all 3 parity tests PASS.

- [ ] **Step 3: Retire the yaml.** Delete `libpostal/openapi.yaml` (`git rm libpostal/openapi.yaml`), remove `"openapi.yaml"` from `libpostal/package.json`'s `files` array, and delete `libpostal/openapi-parity.test.ts` (`git rm`) — the gate is one-time; the emitted document is now the only spec, continuously exercised by the `/openapi.json` test from Task 4.

- [ ] **Step 4: Full-suite check + commit**

Run: `yarn vitest run --dir ./libpostal && yarn compile`
Expected: PASS / clean.

```bash
git add -A libpostal
git commit -m "feat(libpostal): retire the handwritten OpenAPI yaml — the emitted document is the spec

Parity gate adjudications: <list each yaml-side bug found in Step 2, e.g.
'additionalProperties: false on ParseRequest/ExpandRequest — the server
always tolerated extra keys'>"
```

---

### Task 6: CLI onto `serveNode`; README; end-to-end smoke

**Files:**

- Modify: `libpostal/cli.ts`
- Modify: `libpostal/README.md` (the express-mention + POST-body caveat paragraphs)
- Test: manual smoke against the compiled CLI (commands below)

**Interfaces:**

- Consumes: `createLibpostalApp` (Task 4), `serveNode` (Task 2). Engine wiring (`createAddressParser`, `@mailwoman/normalize`) is **unchanged**.
- Produces: `mailwoman-libpostal serve [--port 8081] [--host 0.0.0.0] [--no-cors]` — identical flags, identical banner shape, express-free.

- [ ] **Step 1: Rewrite `libpostal/cli.ts`.** Keep the header docstring (update the express mention), the `parseArgs` subcommand dispatch, flags, defaults, and the engine wiring verbatim. Replace the express boot:

```ts
// (imports: drop `express`; add)
import { serveNode } from "@mailwoman/api-kit"

import { createLibpostalApp } from "./index.ts"

// (inside serve(), after the engine literal — replaces the express().use(...).listen(...) call)
const app = createLibpostalApp(engine, { cors: values.cors })

serveNode({
	fetch: app.fetch,
	port,
	hostname: host,
	onListen: () => {
		console.error(`[@mailwoman/libpostal] listening on http://${host}:${port}`)
		console.error(`  cors: ${values.cors ? "enabled (Access-Control-Allow-Origin: *)" : "disabled (--no-cors)"}`)
		console.error(`  endpoints: POST/GET /parse  POST/GET /expand  GET /openapi.json`)
	},
})
```

- [ ] **Step 2: Update `libpostal/README.md`.** Remove the "mount a JSON body parser" caveat (POST JSON is native now), mention `GET /openapi.json`, and swap any `createLibpostalRouter`/express usage snippet for `createLibpostalApp` + `serveNode`. Keep all curl examples byte-identical — they must still work.

- [ ] **Step 3: Compile, then smoke the real flow** (compile first — the bin runs `out/cli.js`)

```bash
yarn compile
node libpostal/out/cli.js serve --port 18081 &
sleep 8   # model load
curl -s 'http://127.0.0.1:18081/parse?query=1600+pennsylvania+ave+washington+dc'
curl -s -X POST 'http://127.0.0.1:18081/parse' -H 'content-type: application/json' -d '{"query":"1600 pennsylvania ave washington dc"}'
curl -s 'http://127.0.0.1:18081/expand?address=1600+pennsylvania+ave+nw'
curl -s 'http://127.0.0.1:18081/parse' | head -c 200; echo
curl -s 'http://127.0.0.1:18081/openapi.json' | head -c 200; echo
kill %1   # the exact PID of OUR spawn — never pkill by pattern (standing rule)
```

Expected: parse returns the labeled-component array (GET and POST identical); expand returns `{"expansions":[...]}`; bare `/parse` returns `{"error":"query is required"}`; `/openapi.json` starts with `{"openapi":"3.1.0"`.

- [ ] **Step 4: Commit**

```bash
git add libpostal
git commit -m "feat(libpostal): serve via api-kit serveNode; POST JSON bodies now native"
```

---

### Task 7: Repo-wide green + branch wrap

**Files:**

- No new files — verification only (fix-forward anything it surfaces).

- [ ] **Step 1: Clean-tree rebuild of the touched workspaces** (stale `out/` masks missing tsconfig refs — standing rule)

```bash
rm -rf api-kit/out libpostal/out
yarn compile
```

Expected: clean.

- [ ] **Step 2: Full test + lint**

```bash
yarn vitest run --dir ./api-kit --dir ./libpostal
yarn test:integration
yarn lint:oxlint && yarn oxfmt --check api-kit libpostal
```

Expected: all pass. (`test:integration` covers the CLI-level suites; pre-existing oxfmt failures elsewhere in the repo are out of scope.)

- [ ] **Step 3: Confirm no express references remain in libpostal**

Run: `grep -rn "express" libpostal --include="*.ts" --include="*.json" | grep -v out/`
Expected: no hits (README prose mentioning the old stack is fine only if historical/dated).

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/hono-api
gh pr create --title "feat!: Hono API surface, phase 1 — api-kit + libpostal migration" --body "<summarize: spec link, api-kit contents, libpostal wire-parity receipts (test list), yaml retirement adjudications, breaking notes (createLibpostalRouter removed — next-major train)>"
```

⚠ Do not merge — next-major train (with #1074 and the #875 casing batch). Note this in the PR body.

---

## Deferred to later phases (deliberate, per spec §Order)

- **Phase 2 (photon)**: GeoJSON/LonLat/BBox wire atoms in api-kit (first consumer), photon migration + parity gate.
- **Phase 3 (nominatim)**: nominatim migration + parity gate.
- **Phase 4 (native API)**: `@mailwoman/api` workspace, api-kit error envelope + metrics port (`mailwoman/server/metrics.ts` moves), `mailwoman serve` mounting, `mailwoman/server/` deletion + express removal repo-wide.
- **Phase 5 (CI clients)**: spec artifacts in the release workflow, Python/Rust generation + publishing, `feat/api-clients` branch closure.
