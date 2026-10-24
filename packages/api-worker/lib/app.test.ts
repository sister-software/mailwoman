/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { createAPIWorkerApp } from "#app"

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

		const response = await app.request("http://earth.test/v1/geocode", {
			method: "POST",
			headers: { "content-type": "application/json", cookie: "private=value" },
			body: '{"address":"1600 Pennsylvania Avenue NW, Washington, DC 20500"}',
		})

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

		expect((await app.request("http://earth.test/v1/reload", { method: "POST" })).status).toBe(404)
		expect((await app.request("http://earth.test/health")).status).toBe(503)

		const response = await app.request("http://earth.test/v1/parse", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"address":"Paris"}',
		})

		expect(response.status).toBe(502)
		expect(await response.json()).toEqual({ error: "backend unavailable" })
	})
})
