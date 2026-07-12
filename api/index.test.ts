/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { metricsSnapshot, resetMetricsForTest } from "@mailwoman/api-kit"
import type { SerializedSolution } from "@mailwoman/core/solver"
import { beforeEach, expect, test } from "vitest"

import { createMailwomanAPI, type MailwomanAPIEngine, type ParseOutcome } from "./index.ts"

beforeEach(() => {
	resetMetricsForTest()
})

const fixtureSolution: SerializedSolution = { score: 1, penalty: 0, classifications: {}, matches: [] }

function fixtureParseOutcome(address: string, debug: boolean): ParseOutcome {
	return {
		input: { body: address, start: 0, end: address.length },
		solutions: [fixtureSolution],
		debug: debug ? "diagnostic report" : undefined,
	}
}

function fixtureGeocodeOutcome(address: string) {
	return { address, lat: 38.8977, lon: -77.0365, resolution_tier: "address_point" }
}

/** A fully-wired fixture engine — every method present, exercising every 200 happy path. */
const fullEngine: MailwomanAPIEngine = {
	parse: async (address, opts) => fixtureParseOutcome(address, opts.debug),
	geocode: async (address) => fixtureGeocodeOutcome(address),
	batch: async (addresses) => ({
		results: addresses.map((a) => (a === "bad" ? { input: a, error: "boom" } : fixtureGeocodeOutcome(a))),
	}),
	resolveTree: async (tree) => ({ tree }),
	reload: async () => ({ reloaded: true, versions: { wof: "v1" } }),
	health: () => ({ model: { name: "test-model", version: "0.0.0" } }),
}

// ---------------------------------------------------------------------------------------------
// /v1/parse
// ---------------------------------------------------------------------------------------------

test("POST /v1/parse: happy path returns the tokenized span + solutions", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/parse", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "1600 Pennsylvania Ave NW" }),
	})
	expect(res.status).toBe(200)
	const body = (await res.json()) as ParseOutcome
	expect(body.input.body).toBe("1600 Pennsylvania Ave NW")
	expect(body.solutions).toHaveLength(1)
	expect(body.debug).toBeUndefined()
})

test("POST /v1/parse: debug:true reaches the engine and rides back in the response", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/parse", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "1600 Pennsylvania Ave NW", debug: true }),
	})
	const body = (await res.json()) as ParseOutcome
	expect(body.debug).toBe("diagnostic report")
})

test("GET /v1/parse?address=&debug=: happy path, first-value query reads", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/parse?address=1600+Pennsylvania+Ave+NW&debug=true")
	expect(res.status).toBe(200)
	const body = (await res.json()) as ParseOutcome
	expect(body.input.body).toBe("1600 Pennsylvania Ave NW")
	expect(body.debug).toBe("diagnostic report")
})

test('POST /v1/parse: missing address body key -> 400 { error: "address is required" }', async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/parse", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: "address is required" })
})

test('POST /v1/parse: empty-string address -> 400 { error: "address is required" }', async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/parse", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "   " }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: "address is required" })
})

test('GET /v1/parse: absent address -> 400 { error: "address is required" }', async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/parse")
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: "address is required" })
})

test("POST /v1/parse: engine.parse absent -> 501", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/parse", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "1600 Pennsylvania Ave NW" }),
	})
	expect(res.status).toBe(501)
	expect(await res.json()).toEqual({ error: "parse not implemented" })
})

test("GET /v1/parse: engine.parse absent -> 501", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/parse?address=x")
	expect(res.status).toBe(501)
	expect(await res.json()).toEqual({ error: "parse not implemented" })
})

// ---------------------------------------------------------------------------------------------
// /v1/geocode
// ---------------------------------------------------------------------------------------------

test("POST /v1/geocode: happy path passes the GeocodeOutcome through verbatim", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/geocode", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "1600 Pennsylvania Ave NW" }),
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual(fixtureGeocodeOutcome("1600 Pennsylvania Ave NW"))
})

test('POST /v1/geocode: missing address -> 400 { error: "address is required" }', async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/geocode", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: "address is required" })
})

test("POST /v1/geocode: engine.geocode absent -> 503 (deps missing in production)", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/geocode", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "x" }),
	})
	expect(res.status).toBe(503)
	expect(await res.json()).toEqual({ error: "geocoder not available" })
})

test("POST /v1/geocode: a thrown engine error is recorded as an error tier, then rethrown into the 500 net", async () => {
	const app = createMailwomanAPI({
		geocode: async () => {
			throw new Error("resolver exploded")
		},
	})
	const res = await app.request("/v1/geocode", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "x" }),
	})
	expect(res.status).toBe(500)
	expect(await res.json()).toEqual({ error: "internal error", detail: "resolver exploded" })

	const metricsRes = await app.request("/metrics")
	const snapshot = (await metricsRes.json()) as { timings: { errors: number } }
	expect(snapshot.timings.errors).toBe(1)
})

// ---------------------------------------------------------------------------------------------
// /v1/batch
// ---------------------------------------------------------------------------------------------

test("POST /v1/batch: happy path returns one row per address, in order, per-row error isolation", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/batch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ addresses: ["1600 Pennsylvania Ave NW", "bad"] }),
	})
	expect(res.status).toBe(200)
	const body = (await res.json()) as { results: unknown[] }
	expect(body.results).toEqual([fixtureGeocodeOutcome("1600 Pennsylvania Ave NW"), { input: "bad", error: "boom" }])
})

test("POST /v1/batch: empty addresses array -> 200 { results: [] }, even with no engine", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/batch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ addresses: [] }),
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ results: [] })
})

test('POST /v1/batch: wrong body shape -> 400 { error: "body must be { addresses: string[] } " }', async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/batch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ addresses: ["ok", 42] }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: "body must be { addresses: string[] }" })
})

test("POST /v1/batch: over batchMax -> 413", async () => {
	const app = createMailwomanAPI(fullEngine, { batchMax: 2 })
	const res = await app.request("/v1/batch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ addresses: ["a", "b", "c"] }),
	})
	expect(res.status).toBe(413)
	expect(await res.json()).toEqual({ error: "batch too large: 3 > 2" })
})

test("POST /v1/batch: engine.batch absent -> 503", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/batch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ addresses: ["a"] }),
	})
	expect(res.status).toBe(503)
	expect(await res.json()).toEqual({ error: "geocoder not available" })
})

test("/v1/batch records whole-call latency under the batch tier", async () => {
	resetMetricsForTest()
	const app = createMailwomanAPI({ batch: async () => ({ results: [] }) })
	await app.request("/v1/batch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ addresses: ["x"] }),
	})
	const snapshot = metricsSnapshot()
	expect(snapshot.timings.tiers["batch"]).toBe(1)
})

// ---------------------------------------------------------------------------------------------
// /v1/resolve
// ---------------------------------------------------------------------------------------------

test("POST /v1/resolve: happy path returns { tree } passed through the engine", async () => {
	const app = createMailwomanAPI(fullEngine)
	const tree = { raw: "Berlin", roots: [] }
	const res = await app.request("/v1/resolve", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tree }),
	})
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ tree })
})

test('POST /v1/resolve: wrong body shape -> 400 { error: "body must be { tree: AddressTree, opts? } " }', async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/resolve", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: "body must be { tree: AddressTree, opts? }" })
})

test("POST /v1/resolve: engine.resolveTree absent -> 503", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/resolve", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tree: { raw: "x", roots: [] } }),
	})
	expect(res.status).toBe(503)
	expect(await res.json()).toEqual({ error: "resolver not available" })
})

// ---------------------------------------------------------------------------------------------
// /v1/reload
// ---------------------------------------------------------------------------------------------

test("POST /v1/reload: happy path passes { reloaded, versions } through", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/reload", { method: "POST" })
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ reloaded: true, versions: { wof: "v1" } })
})

test("POST /v1/reload: engine.reload absent -> 503", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/reload", { method: "POST" })
	expect(res.status).toBe(503)
	expect(await res.json()).toEqual({ error: "geocoder not available" })
})

// ---------------------------------------------------------------------------------------------
// /v1/format — wired in-package, no engine method, always available
// ---------------------------------------------------------------------------------------------

test("POST /v1/format: round-trips components into a formatted string + a non-empty canonicalKey", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/format", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			components: { house_number: "1600", road: "Pennsylvania Ave NW", city: "Washington" },
			country: "US",
		}),
	})
	expect(res.status).toBe(200)
	const body = (await res.json()) as { formatted: string; canonicalKey: string }
	// The formatter template owns the exact rendering — only pin the load-bearing substring.
	expect(body.formatted).toContain("1600")
	expect(body.canonicalKey.length).toBeGreaterThan(0)
})

test("POST /v1/format: a multi-span component value collapses to its first span", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/format", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			components: { house_number: ["1600", "1601"], road: "Pennsylvania Ave NW" },
			country: "US",
		}),
	})
	expect(res.status).toBe(200)
	const body = (await res.json()) as { formatted: string }
	expect(body.formatted).toContain("1600")
	expect(body.formatted).not.toContain("1601")
})

test("POST /v1/format: a missing required field -> 400 in the api-kit envelope, NOT the raw zod shape", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/format", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ country: "US" }), // components missing
	})
	expect(res.status).toBe(400)
	const body = (await res.json()) as Record<string, unknown>
	expect(body["error"]).toBe("invalid request body")
	expect(typeof body["detail"]).toBe("string")
	// The api-kit envelope is exactly {error, detail?} — assert the raw zod validator shape leaked nowhere.
	expect(body["success"]).toBeUndefined()
	expect(body["issues"]).toBeUndefined()
	expect(Object.keys(body).sort()).toEqual(["detail", "error"])
})

// ---------------------------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------------------------

test("GET /health: with an engine, spreads engine.health() alongside status + uptime_s", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/health")
	expect(res.status).toBe(200)
	const body = (await res.json()) as Record<string, unknown>
	expect(body["status"]).toBe("ok")
	expect(typeof body["uptime_s"]).toBe("number")
	expect(body["model"]).toEqual({ name: "test-model", version: "0.0.0" })
})

test("GET /health: without an engine, still answers 200 with status + uptime_s (health answers even when broken)", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/health")
	expect(res.status).toBe(200)
	const body = (await res.json()) as Record<string, unknown>
	expect(body["status"]).toBe("ok")
	expect(typeof body["uptime_s"]).toBe("number")
})

// ---------------------------------------------------------------------------------------------
// /metrics
// ---------------------------------------------------------------------------------------------

test("GET /metrics: reflects a recorded /v1/geocode call", async () => {
	const app = createMailwomanAPI(fullEngine)
	const before = (await (await app.request("/metrics")).json()) as { timings: { total: number } }
	expect(before.timings.total).toBe(0)

	await app.request("/v1/geocode", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "1600 Pennsylvania Ave NW" }),
	})

	const after = (await (await app.request("/metrics")).json()) as {
		timings: { total: number; tiers: Record<string, number> }
	}
	expect(after.timings.total).toBe(1)
	expect(after.timings.tiers["address_point"]).toBe(1)
})

// ---------------------------------------------------------------------------------------------
// /openapi.json
// ---------------------------------------------------------------------------------------------

test("GET /openapi.json: documents all 8 native paths, and is not self-referenced", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/openapi.json")
	expect(res.status).toBe(200)
	const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
	expect(doc.openapi).toBe("3.1.0")
	expect(Object.keys(doc.paths).sort()).toEqual(
		["/health", "/metrics", "/v1/batch", "/v1/format", "/v1/geocode", "/v1/parse", "/v1/reload", "/v1/resolve"].sort()
	)
	expect(doc.paths["/openapi.json"]).toBeUndefined()
})

test("GET /openapi.json: full-info document config lands (license, contact, servers, security, tags)", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/openapi.json")
	const doc = (await res.json()) as {
		info: { license?: { name: string }; contact?: { name?: string; url?: string } }
		servers?: Array<{ url: string }>
		security?: unknown[]
		tags?: Array<{ name: string }>
	}
	expect(doc.info.license?.name).toBe("AGPL-3.0-only OR LicenseRef-Commercial")
	expect(doc.info.contact?.url).toBe("https://mailwoman.sister.software")
	expect(doc.servers?.[0]?.url).toBe("http://{host}:{port}")
	expect(doc.security).toEqual([])
	expect(doc.tags?.map((t) => t.name)).toContain("meta")
})

// ---------------------------------------------------------------------------------------------
// CORS + body limit + the 500 safety net
// ---------------------------------------------------------------------------------------------

test("CORS: permissive Access-Control-Allow-Origin on responses (browser clients), GET/POST/OPTIONS", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/health")
	expect(res.headers.get("access-control-allow-origin")).toBe("*")
})

test("CORS: preflight OPTIONS answers 204 with GET/POST/OPTIONS in Allow-Methods", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/geocode", {
		method: "OPTIONS",
		headers: { origin: "https://example.com", "access-control-request-method": "POST" },
	})
	expect(res.status).toBe(204)
	const allowed = res.headers.get("access-control-allow-methods") ?? ""
	expect(allowed).toContain("GET")
	expect(allowed).toContain("POST")
	expect(allowed).toContain("OPTIONS")
})

test("CORS: { cors: false } disables the headers (for a proxy that owns CORS)", async () => {
	const app = createMailwomanAPI(fullEngine, { cors: false })
	const res = await app.request("/health")
	expect(res.headers.get("access-control-allow-origin")).toBeNull()
})

test("bodyLimitBytes: an oversized /v1/* POST answers 413, not a buffered crash", async () => {
	const app = createMailwomanAPI(fullEngine, { bodyLimitBytes: 16 })
	const res = await app.request("/v1/geocode", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "well over sixteen bytes" }),
	})
	expect(res.status).toBe(413)
	expect(await res.json()).toEqual({ error: "request body too large" })
})

test("an engine fault answers the native 500 envelope with a helpful detail, never a crash", async () => {
	const app = createMailwomanAPI({
		parse: async () => {
			throw new Error("model exploded")
		},
	})
	const res = await app.request("/v1/parse?address=x")
	expect(res.status).toBe(500)
	expect(await res.json()).toEqual({ error: "internal error", detail: "model exploded" })
})

test("malformed JSON answers a 400 envelope, not a 500", async () => {
	const app = createMailwomanAPI({})
	const res = await app.request("/v1/format", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{truncated",
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: "invalid request body", detail: "malformed JSON" })
})
