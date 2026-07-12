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

test("an empty higher-precedence query param wins precedence and 400s (legacy parity — no fallback to address)", async () => {
	const app = createLibpostalApp(fixtureEngine)

	const viaQuery = await app.request("/parse?query=&address=1600+pennsylvania+ave")
	expect(viaQuery.status).toBe(400)
	expect(await viaQuery.json()).toEqual({ error: "query is required" })

	const viaBody = await app.request("/parse?address=1600+pennsylvania+ave", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: "" }),
	})
	expect(viaBody.status).toBe(400)
	expect(await viaBody.json()).toEqual({ error: "query is required" })
})

test("POST /parse with malformed JSON is tolerated like the served legacy endpoint (falls through to query params)", async () => {
	const app = createLibpostalApp(fixtureEngine)

	const withParam = await app.request("/parse?query=1600+pennsylvania+ave", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{truncated",
	})
	expect(withParam.status).toBe(200)

	const without = await app.request("/parse", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{truncated",
	})
	expect(without.status).toBe(400)
	expect(await without.json()).toEqual({ error: "query is required" })
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

test("CORS preflight carries the legacy header values (Allow-Headers *, Max-Age 86400)", async () => {
	const app = createLibpostalApp(fixtureEngine)
	const res = await app.request("/parse", {
		method: "OPTIONS",
		headers: { origin: "https://example.com", "access-control-request-method": "POST" },
	})
	expect(res.status).toBe(204)
	expect(res.headers.get("access-control-allow-headers")).toBe("*")
	expect(res.headers.get("access-control-max-age")).toBe("86400")
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
