/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { TileSource } from "./tile-source.ts"

const FIXTURE = fileURLToPath(new URL("./test/fixtures/portland.pmtiles", import.meta.url))

describe("TileSource", async () => {
	const source = await TileSource.open(FIXTURE)

	afterAll(() => source.close())

	it("reads header zoom bounds", () => {
		expect(source.minZoom).toBe(0)
		expect(source.maxZoom).toBeGreaterThanOrEqual(14)
	})

	it("decodes the z0 world tile with the fixture layers", async () => {
		const tile = await source.getTile(0, 0, 0)
		expect(tile).not.toBeNull()
		const names = tile!.layers.map((layer) => layer.name).toSorted()
		expect(names).toContain("earth")
		expect(names).toContain("roads")
	})

	it("finds SE Clinton St at high zoom", async () => {
		// z14 tile containing (-122.6023, 45.5034): x = floor(2**14 * (lon/360 + 0.5)) = 2612,
		// y = floor(lonLatToWorldPx(lon, lat, 14).y / 256) = 5861.
		const tile = await source.getTile(14, 2612, 5861)
		expect(tile).not.toBeNull()
		const roads = tile!.layers.find((layer) => layer.name === "roads")
		const named = roads!.features.map((f) => f.properties["name"]).filter(Boolean)
		expect(named).toContain("SE Clinton St")
	})

	it("returns null for a tile outside the archive", async () => {
		expect(await source.getTile(14, 0, 0)).toBeNull()
	})
})
