/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `buildToolTable` against stub deps — no MCP transport/server involved (that's exercised by the stdio smoke run
 *   in CI, not here). Covers: all five tools present, each schema accepts a canonical example + rejects a bad one,
 *   and each handler routes to the correct dep with the correct arguments.
 */

import { describe, expect, it, vi } from "vitest"

import { buildToolTable, type MCPToolDeps } from "./tools.ts"

function stubDeps(): MCPToolDeps {
	return {
		parse: vi.fn(async () => ({ tag: "parsed" })),
		geocode: vi.fn(async () => ({ tag: "geocoded" })),
		poiSearch: vi.fn(async () => ({ tag: "poi-searched" })),
		overpassExport: vi.fn(async () => '[out:json][timeout:25];\nnwr["amenity"="cafe"];\nout center;'),
		layerManifest: vi.fn(async () => ({ tag: "manifest" })),
	}
}

function toolNamed(table: ReturnType<typeof buildToolTable>, name: string) {
	const tool = table.find((t) => t.name === name)

	if (!tool) throw new Error(`no tool named ${name}`)

	return tool
}

describe("buildToolTable", () => {
	it("registers exactly the five expected tools", () => {
		const table = buildToolTable(stubDeps())

		expect(table.map((t) => t.name).sort()).toEqual(
			[
				"mailwoman_geocode",
				"mailwoman_layer_manifest",
				"mailwoman_overpass_export",
				"mailwoman_parse",
				"mailwoman_poi_search",
			].sort()
		)
	})

	it("every tool carries a non-empty description", () => {
		const table = buildToolTable(stubDeps())

		for (const tool of table) {
			expect(tool.description.length).toBeGreaterThan(20)
		}
	})

	describe("mailwoman_parse", () => {
		it("accepts a canonical example and rejects a missing text field", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_parse")

			expect(tool.inputSchema.safeParse({ text: "350 5th Ave, New York, NY 10118" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({ text: "coffee near me", poi: true }).success).toBe(true)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
			expect(tool.inputSchema.safeParse({ text: "" }).success).toBe(false)
		})

		it("routes to deps.parse with the poi flag threaded through", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_parse")

			await tool.handler({ text: "350 5th Ave", poi: true })
			expect(deps.parse).toHaveBeenCalledWith("350 5th Ave", { poi: true })
		})

		it("defaults poi to undefined when omitted", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_parse")

			await tool.handler({ text: "350 5th Ave" })
			expect(deps.parse).toHaveBeenCalledWith("350 5th Ave", { poi: undefined })
		})
	})

	describe("mailwoman_geocode", () => {
		it("accepts a canonical example and rejects an empty string", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_geocode")

			expect(tool.inputSchema.safeParse({ text: "350 5th Ave, New York, NY 10118" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({ text: "" }).success).toBe(false)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
		})

		it("routes to deps.geocode", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_geocode")

			await tool.handler({ text: "350 5th Ave, New York, NY 10118" })
			expect(deps.geocode).toHaveBeenCalledWith("350 5th Ave, New York, NY 10118")
		})
	})

	describe("mailwoman_poi_search", () => {
		it("accepts a canonical example (with and without poiDatabasePath) and rejects a missing query", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_poi_search")

			expect(tool.inputSchema.safeParse({ query: "coffee near 350 5th Ave, New York" }).success).toBe(true)
			expect(
				tool.inputSchema.safeParse({ query: "coffee near 350 5th Ave, New York", poiDatabasePath: "/tmp/poi.db" })
					.success
			).toBe(true)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
			expect(tool.inputSchema.safeParse({ query: "" }).success).toBe(false)
		})

		it("routes to deps.poiSearch with the query + optional db path", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_poi_search")

			await tool.handler({ query: "coffee near 350 5th Ave", poiDatabasePath: "/tmp/poi.db" })
			expect(deps.poiSearch).toHaveBeenCalledWith({
				query: "coffee near 350 5th Ave",
				poiDatabasePath: "/tmp/poi.db",
			})
		})
	})

	describe("mailwoman_overpass_export", () => {
		it("accepts a canonical example and rejects a missing query", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_overpass_export")

			expect(tool.inputSchema.safeParse({ query: "cafes in Paris" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
			expect(tool.inputSchema.safeParse({ query: "" }).success).toBe(false)
		})

		it("routes to deps.overpassExport and returns its raw string", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_overpass_export")

			const result = await tool.handler({ query: "cafes in Paris" })
			expect(deps.overpassExport).toHaveBeenCalledWith("cafes in Paris")
			expect(result).toBe('[out:json][timeout:25];\nnwr["amenity"="cafe"];\nout center;')
		})
	})

	describe("mailwoman_layer_manifest", () => {
		it("accepts a canonical example and rejects a missing databasePath", () => {
			const tool = toolNamed(buildToolTable(stubDeps()), "mailwoman_layer_manifest")

			expect(tool.inputSchema.safeParse({ databasePath: "/data/poi.db" }).success).toBe(true)
			expect(tool.inputSchema.safeParse({}).success).toBe(false)
			expect(tool.inputSchema.safeParse({ databasePath: "" }).success).toBe(false)
		})

		it("routes to deps.layerManifest", async () => {
			const deps = stubDeps()
			const tool = toolNamed(buildToolTable(deps), "mailwoman_layer_manifest")

			await tool.handler({ databasePath: "/data/poi.db" })
			expect(deps.layerManifest).toHaveBeenCalledWith("/data/poi.db")
		})
	})
})
