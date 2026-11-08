/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { TileJSON } from "@mailwoman/cartographer"
import type { ExecutionContext as HonoExecutionContext } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createTileWorkerApp } from "#app"
import type { ResponseCache } from "#caching"
import { CloudflareWorkerPMTiles } from "#protomaps"

const executionContext: HonoExecutionContext = {
	waitUntil: () => {},
	passThroughOnException: () => {},
	props: {},
}

const noCache: ResponseCache = { match: async () => null, put: async () => {} }

const env = { MAILWOMAN_TILES_BUCKET: {} as R2Bucket, PMTILES_PATH: "tiles" }

const planetTileJSON: TileJSON = {
	tilejson: "3.0.0",
	name: "Protomaps Basemap",
	version: "4.15.2",
	scheme: "xyz",
	tiles: ["https://tiles.mailwoman.post/planet.v4/{z}/{x}/{y}.mvt"],
	vector_layers: [],
	bounds: [-180, -90, 180, 90],
	center: [0, 0, 0],
	minzoom: 0,
	maxzoom: 15,
	attribution: "© OpenStreetMap",
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("/styles/<style>.json", () => {
	it("answers a MapLibre style whose one source names the planet tile template and zoom range", async () => {
		const retrieve = vi.spyOn(CloudflareWorkerPMTiles.prototype, "retrieveTileJSON").mockResolvedValue(planetTileJSON)
		const app = createTileWorkerApp({ cache: noCache })

		const response = await app.request("/styles/light.json", {}, env, executionContext)

		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("application/json")
		expect(retrieve).toHaveBeenCalledWith("planet.v4")

		const style = (await response.json()) as { version: number; sources: Record<string, unknown>; layers: unknown[] }

		expect(style.version).toBe(8)

		expect(style.sources).toEqual({
			"planet.v4": {
				type: "vector",
				tiles: planetTileJSON.tiles,
				minzoom: 0,
				maxzoom: 15,
				bounds: planetTileJSON.bounds,
				attribution: planetTileJSON.attribution,
			},
		})

		expect(style.layers.length).toBeGreaterThan(50)
	})

	it("labels in the lang query parameter's language", async () => {
		vi.spyOn(CloudflareWorkerPMTiles.prototype, "retrieveTileJSON").mockResolvedValue(planetTileJSON)
		const app = createTileWorkerApp({ cache: noCache })

		const response = await app.request("/styles/mailwoman.json?lang=ja", {}, env, executionContext)

		expect(response.status).toBe(200)
		await expect(response.text()).resolves.toContain("name:ja")
	})

	it("refuses an unknown style with 404 and a malformed language with 400, before reading R2", async () => {
		const retrieve = vi.spyOn(CloudflareWorkerPMTiles.prototype, "retrieveTileJSON")
		const app = createTileWorkerApp({ cache: noCache })

		const unknown = await app.request("/styles/neon.json", {}, env, executionContext)
		const badLang = await app.request("/styles/light.json?lang=en%3Bdrop", {}, env, executionContext)

		expect(unknown.status).toBe(404)
		expect(badLang.status).toBe(400)
		expect(retrieve).not.toHaveBeenCalled()
	})
})
