/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { tryParsingJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import type { RequestLimiter } from "#admission"
import { type APIBackend, createAPIWorkerApp } from "#app"
import { REQUEST_LOCATION_WEIGHT } from "#request-bias"

const EARTH = "https://earth.mailwoman.ai"

/**
 * A backend that records each request it receives and answers `{ ok: true }`.
 */
function recordingBackend(): APIBackend & { received: Request[] } {
	const received: Request[] = []

	return {
		received,
		fetch: async (request) => {
			received.push(request)

			return Response.json({ ok: true })
		},
	}
}

/**
 * A limiter that admits the first `budget` requests per key.
 */
function countingLimiter(budget: number): RequestLimiter & { keys: string[] } {
	const keys: string[] = []

	return {
		keys,
		limit: async ({ key }) => {
			keys.push(key)

			return { success: keys.filter((seen) => seen === key).length <= budget }
		},
	}
}

function postFrom(origin: string | null, path: string, body: string, headers: Record<string, string> = {}) {
	return {
		path: `http://api.test${path}`,
		init: {
			method: "POST",
			headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...headers },
			body,
		},
	}
}

describe("createAPIWorkerApp", () => {
	it("preserves native status, body, and engine headers while filtering client headers", async () => {
		const received: Request[] = []

		const app = createAPIWorkerApp({
			fetch: async (request) => {
				received.push(request)

				return Response.json(
					{ error: "invalid request body", detail: "address: required" },
					{ status: 400, headers: { Server: "mailwoman/10.7.0", Link: "<https://mailwoman.ai/license>; rel=license" } }
				)
			},
		})

		const { path, init } = postFrom(
			EARTH,
			"/v1/geocode",
			'{"address":"1600 Pennsylvania Avenue NW, Washington, DC 20500"}',
			{ cookie: "private=value" }
		)

		const response = await app.request(path, init)

		expect(response.status).toBe(400)
		expect(response.headers.get("server")).toBe("mailwoman/10.7.0")
		expect(response.headers.get("link")).toBe("<https://mailwoman.ai/license>; rel=license")
		expect(await response.json()).toEqual({ error: "invalid request body", detail: "address: required" })
		expect(received[0]?.url).toBe("http://engine.internal/v1/geocode")
		expect(received[0]?.headers.get("cookie")).toBeNull()
		expect(await received[0]?.text()).toBe('{"address":"1600 Pennsylvania Avenue NW, Washington, DC 20500"}')
	})

	it("does not expose backend administration and reports backend failure", async () => {
		const app = createAPIWorkerApp({
			fetch: async () => {
				throw new Error("connection refused")
			},
		})

		const reload = postFrom(EARTH, "/v1/reload", "{}")

		expect((await app.request(reload.path, reload.init)).status).toBe(404)
		expect((await app.request("http://api.test/health")).status).toBe(503)

		const { path, init } = postFrom(EARTH, "/v1/parse", '{"address":"Paris"}')
		const response = await app.request(path, init)

		expect(response.status).toBe(502)
		expect(await response.json()).toEqual({ error: "backend unavailable" })
	})

	it("replaces the backend's CORS policy with the Worker's origin list", async () => {
		const app = createAPIWorkerApp({
			fetch: async () => Response.json({ ok: true }, { headers: { "Access-Control-Allow-Origin": "*" } }),
		})

		const { path, init } = postFrom(EARTH, "/v1/parse", '{"address":"Berlin"}')

		expect((await app.request(path, init)).headers.get("access-control-allow-origin")).toBe(EARTH)
	})

	it("answers 504 when the backend passes the deadline", async () => {
		const app = createAPIWorkerApp(
			{
				fetch: (request) =>
					new Promise((_, reject) => {
						request.signal.addEventListener("abort", () => reject(request.signal.reason))
					}),
			},
			{ deadlineMs: 10 }
		)

		const { path, init } = postFrom(EARTH, "/v1/geocode", '{"address":"Berlin"}')
		const response = await app.request(path, init)

		expect(response.status).toBe(504)
		expect(await response.json()).toEqual({ error: "backend timeout" })
	})
})

describe("admission", () => {
	it("refuses a request without an allowed Origin with 403 before the backend sees it", async () => {
		const backend = recordingBackend()
		const app = createAPIWorkerApp(backend)

		for (const origin of [null, "https://example.com"]) {
			const { path, init } = postFrom(origin, "/v1/geocode", '{"address":"Berlin"}')
			const response = await app.request(path, init)

			expect(response.status).toBe(403)
			expect(await response.json()).toEqual({ error: "origin not allowed" })
		}

		expect(backend.received).toHaveLength(0)
		expect((await app.request("http://api.test/health")).status).toBe(200)
	})

	it("answers a CORS preflight from an allowed origin without spending the budget", async () => {
		const limiter = countingLimiter(1)
		const app = createAPIWorkerApp(recordingBackend(), { limiter })

		const response = await app.request("http://api.test/v1/geocode", {
			method: "OPTIONS",
			headers: { origin: EARTH, "access-control-request-method": "POST" },
		})

		expect(response.status).toBe(204)
		expect(limiter.keys).toHaveLength(0)
	})

	it("answers 429 with Retry-After once a client passes its budget, keyed by CF-Connecting-IP", async () => {
		const backend = recordingBackend()
		const limiter = countingLimiter(2)
		const app = createAPIWorkerApp(backend, { limiter, limitPeriodSeconds: 60 })

		const send = (ip: string) => {
			const { path, init } = postFrom(EARTH, "/v1/geocode", '{"address":"Berlin"}', { "cf-connecting-ip": ip })

			return app.request(path, init)
		}

		expect((await send("203.0.113.7")).status).toBe(200)
		expect((await send("203.0.113.7")).status).toBe(200)

		const refused = await send("203.0.113.7")

		expect(refused.status).toBe(429)
		expect(refused.headers.get("retry-after")).toBe("60")
		expect((await send("198.51.100.4")).status).toBe(200)
		expect(backend.received).toHaveLength(3)
	})
})

describe("request-location bias", () => {
	const location = { lat: 51.5072, lon: -0.1276, weight: REQUEST_LOCATION_WEIGHT }

	it("appends the request's location after the page's own bias points on a geocode request", async () => {
		const backend = recordingBackend()
		const app = createAPIWorkerApp(backend, { requestLocation: () => location })

		const { path, init } = postFrom(
			EARTH,
			"/v1/geocode",
			'{"address":"Springfield","bias":[{"lat":39.8,"lon":-89.65,"weight":1}]}'
		)

		await app.request(path, init)

		expect(tryParsingJSON(await backend.received[0]!.text())).toEqual({
			address: "Springfield",
			bias: [{ lat: 39.8, lon: -89.65, weight: 1 }, location],
		})
	})

	it("leaves a parse request, a body that is not a JSON object, and a request without a location unchanged", async () => {
		const backend = recordingBackend()
		const located = createAPIWorkerApp(backend, { requestLocation: () => location })
		const unlocated = createAPIWorkerApp(backend, { requestLocation: () => null })

		const parse = postFrom(EARTH, "/v1/parse", '{"address":"Springfield"}')
		const malformed = postFrom(EARTH, "/v1/geocode", "not json")
		const plain = postFrom(EARTH, "/v1/geocode", '{"address":"Springfield"}')

		await located.request(parse.path, parse.init)
		await located.request(malformed.path, malformed.init)
		await unlocated.request(plain.path, plain.init)

		expect(await Promise.all(backend.received.map((request) => request.text()))).toEqual([
			'{"address":"Springfield"}',
			"not json",
			'{"address":"Springfield"}',
		])
	})
})
