/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type ExecutionContext as HonoExecutionContext, Hono } from "hono"
import { describe, expect, it } from "vitest"

import { createTileWorkerApp, TILE_WORKER_ROUTES } from "#app"
import type { ResponseCache, TileWorkerHono } from "#caching"

/**
 * A response cache over a Map, standing in for the Workers runtime's cache.
 */
function memoryCache(): ResponseCache & { entries: Map<string, Response> } {
	const entries = new Map<string, Response>()

	return {
		entries,
		match: async (url) => entries.get(url)?.clone() ?? null,
		put: async (url, response) => {
			entries.set(url, response)
		},
	}
}

/**
 * An execution context whose `waitUntil` drops the promise it receives,
 * for `app.request` outside the Workers runtime.
 */
const executionContext: HonoExecutionContext = {
	waitUntil: () => {},
	passThroughOnException: () => {},
	props: {},
}

/**
 * The route table with each handler replaced by one that answers its route's index and parameters.
 */
function routeProbe() {
	const app = new Hono<TileWorkerHono>()

	for (const [index, [path]] of TILE_WORKER_ROUTES.entries()) {
		app.get(path, (c) => c.json({ index, params: c.req.param() }))
	}

	return async (path: string) => {
		const response = await app.request(path)

		return response.status === 200
			? ((await response.json()) as { index: number; params: Record<string, string> })
			: null
	}
}

describe("tile worker routes", () => {
	it("sends each URL shape to the route that served it before the Hono port", async () => {
		const probe = routeProbe()
		const routeOf = async (path: string) => (await probe(path))?.index ?? null

		expect(await routeOf("/db/candidate.db")).toBe(0)
		expect(await routeOf("/tiger/06/blocks.json")).toBe(1)
		expect(await routeOf("/tiger/06/blocks/12/655/1582.mvt")).toBe(2)
		expect(await routeOf("/terrain/terrarium/10/909/403.png")).toBe(3)
		expect(await routeOf("/planet.v4.json")).toBe(4)
		expect(await routeOf("/coverage-v5.json")).toBe(4)
		expect(await routeOf("/planet.v4/15/29103/12905.mvt")).toBe(5)
		expect(await routeOf("/providers/130317/06/coverage/12/655/1582.mvt")).toBe(6)
		expect(await routeOf("/providers/130317/06/coverage.json")).toBe(7)
		expect(await routeOf("/geolocate")).toBe(8)
		expect(await routeOf("/")).toBe(9)
		expect(await routeOf("/heartbeat")).toBe(10)
		expect(await routeOf("/planet.v4/15/29103")).toBeNull()
	})

	it("captures a dotted tile set name and the tile file whole", async () => {
		const probe = routeProbe()

		expect((await probe("/planet.v4/15/29103/12905.mvt"))?.params).toEqual({
			tileSetName: "planet.v4",
			z: "15",
			x: "29103",
			tile: "12905.mvt",
		})

		expect((await probe("/planet.v4.json"))?.params).toEqual({ tileSet: "planet.v4.json" })
	})
})

describe("createTileWorkerApp", () => {
	it("answers the heartbeat and refuses an unknown path with 404 text", async () => {
		const app = createTileWorkerApp({ cache: memoryCache() })

		const heartbeat = await app.request("/heartbeat", {}, {}, executionContext)

		expect(heartbeat.status).toBe(200)
		expect(await heartbeat.text()).toBe("OK")

		const missing = await app.request("/nothing/here/at/all/x", {}, {}, executionContext)

		expect(missing.status).toBe(404)
		expect(await missing.text()).toBe("URL path /nothing/here/at/all/x does not match any known route")
	})

	it("renders a route's ResourceError as its JSON with its status", async () => {
		const app = createTileWorkerApp({ cache: memoryCache() })

		const terrarium = await app.request("/terrain/terrarium/2/9/1.png", {}, {}, executionContext)

		expect(terrarium.status).toBe(400)
		expect(await terrarium.json()).toMatchObject({ status: 400, message: "Invalid terrarium tile coordinates" })

		const database = await app.request("/db/candidate.db", {}, {}, executionContext)

		expect(database.status).toBe(400)
		expect(await database.json()).toMatchObject({ message: "Missing Range header" })

		const geolocation = await app.request("/geolocate", {}, {}, executionContext)

		expect(geolocation.status).toBe(424)
	})

	it("answers a database HEAD with the range capability", async () => {
		const app = createTileWorkerApp({ cache: memoryCache() })
		const response = await app.request("/db/candidate.db", { method: "HEAD" }, {}, executionContext)

		expect(response.status).toBe(200)
		expect(response.headers.get("accept-ranges")).toBe("bytes")
		expect(response.headers.get("x-mailwoman-request")).toBe("candidate")
	})

	it("sets CORS for a Mailwoman site and the map editors, and for no other origin", async () => {
		const app = createTileWorkerApp({ cache: memoryCache() })

		const originHeader = async (origin: string) =>
			(await app.request("/heartbeat", { headers: { origin } }, {}, executionContext)).headers.get(
				"access-control-allow-origin"
			)

		expect(await originHeader("https://earth.mailwoman.ai")).toBe("https://earth.mailwoman.ai")
		expect(await originHeader("https://moon.mailwoman.ai")).toBe("https://moon.mailwoman.ai")
		expect(await originHeader("https://maplibre.org")).toBe("https://maplibre.org")
		expect(await originHeader("vscode-webview://abc123")).toBe("vscode-webview://abc123")
		expect(await originHeader("http://localhost:7781")).toBe("http://localhost:7781")
		expect(await originHeader("https://example.com")).toBeNull()

		const preflight = await app.request(
			"/db/candidate.db",
			{
				method: "OPTIONS",
				headers: {
					origin: "https://earth.mailwoman.ai",
					"access-control-request-method": "GET",
					"access-control-request-headers": "range",
				},
			},
			{},
			executionContext
		)

		expect(preflight.status).toBe(204)
		expect(preflight.headers.get("access-control-allow-headers")).toContain("Range")
	})

	it("answers a cached URL from the cache, with this request's CORS headers", async () => {
		const cache = memoryCache()

		cache.entries.set("http://localhost/planet.v4.json", new Response('{"cached":true}', { status: 200 }))

		const app = createTileWorkerApp({ cache })

		const response = await app.request(
			"http://localhost/planet.v4.json",
			{ headers: { origin: "https://earth.mailwoman.ai" } },
			{},
			executionContext
		)

		expect(await response.json()).toEqual({ cached: true })
		expect(response.headers.get("access-control-allow-origin")).toBe("https://earth.mailwoman.ai")
	})
})
