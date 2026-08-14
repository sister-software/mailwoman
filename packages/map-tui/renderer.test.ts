/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { frameToANSILines } from "./frame.ts"
import { TILE_SIZE, worldPxToLonLat } from "./mercator.ts"
import { MapRenderer } from "./renderer.ts"
import { type DecodedTile, type TileProvider, TileSource } from "./tile-source.ts"

const FIXTURE = fileURLToPath(new URL("./test/fixtures/portland.pmtiles", import.meta.url))

const BLANK_BRAILLE = 0x28_00
const SPACE = 0x20

// The style table's landuse fills, packed as frame colors — uniform fills survive the braille conversion exactly.
const RESIDENTIAL_PACKED = (66 << 16) | (60 << 8) | 52
const COMMERCIAL_PACKED = (72 << 16) | (62 << 8) | 50

function landuseTile(kind: string): DecodedTile {
	const extent = 4096

	return {
		layers: [
			{
				name: "landuse",
				extent,
				features: [
					{
						type: 3,
						geometry: [
							[
								{ x: 0, y: 0 },
								{ x: extent, y: 0 },
								{ x: extent, y: extent },
								{ x: 0, y: extent },
							],
						],
						properties: { kind },
					},
				],
			},
		],
	}
}

/**
 * A provider shaped like the spatially sparse lean archive: one z8 parent tile of residential fill covering z12 tiles
 * 992-1007 × 1488-1503, plus (optionally) a single native z12 commercial tile at 1000/1500.
 */
function stubProvider(options?: { native?: boolean }): TileProvider {
	return {
		minZoom: 0,
		maxZoom: 14,
		attribution: "",
		getTile: (z: number, x: number, y: number) => {
			if (z === 8 && x === 62 && y === 93) return Promise.resolve(landuseTile("residential"))

			if (options?.native && z === 12 && x === 1000 && y === 1500) return Promise.resolve(landuseTile("commercial"))

			return Promise.resolve(null)
		},
	}
}

function plainText(frame: import("./frame.ts").MapFrame): string {
	return frameToANSILines(frame, { color: false }).join("\n")
}

describe("MapRenderer", async () => {
	const source = await TileSource.open(FIXTURE)
	const renderer = new MapRenderer(source)

	afterAll(() => source.close())

	it("renders the Clinton St viewport at z14 (golden frame)", async () => {
		const frame = await renderer.renderFrame({
			centerLon: -122.6023,
			centerLat: 45.5034,
			zoom: 14,
			columns: 60,
			rows: 24,
		})

		expect(plainText(frame)).toMatchSnapshot()
	})

	it("renders the zoomed-out extent at z11 (golden frame)", async () => {
		const frame = await renderer.renderFrame({ centerLon: -122.61, centerLat: 45.51, zoom: 11, columns: 60, rows: 24 })
		expect(plainText(frame)).toMatchSnapshot()
	})

	it("falls back to an ancestor tile where the archive has no native coverage", async () => {
		// The provider has one z8 tile and nothing deeper — the shape of a spatially sparse deep band outside its mask.
		// Without the ancestor walk a z12 viewport here renders blank; with it, the z8 fill rasterizes at the z12
		// projection.
		const sparse = new MapRenderer(stubProvider())
		const center = worldPxToLonLat(1000.5 * TILE_SIZE, 1500.5 * TILE_SIZE, 12)

		const frame = await sparse.renderFrame({
			centerLon: center.lon,
			centerLat: center.lat,
			zoom: 12,
			columns: 40,
			rows: 16,
		})

		let inked = 0

		for (const char of frame.chars) {
			if (char !== BLANK_BRAILLE && char !== SPACE) {
				inked++
			}
		}

		expect(inked).toBeGreaterThan(0)
		expect([...frame.colors]).toContain(RESIDENTIAL_PACKED)
	})

	it("paints native detail over the ancestor fallback where both cover a cell", async () => {
		// Viewport straddles the edge between absent tile 999 (left half — falls back to the z8 parent's residential
		// fill) and native tile 1000 (right half — commercial fill). Coarse tiles rasterize first, so the native fill
		// must win its own cells while the fallback keeps the rest.
		const straddling = new MapRenderer(stubProvider({ native: true }))
		const centerOnEdge = worldPxToLonLat(1000 * TILE_SIZE, 1500.5 * TILE_SIZE, 12)

		const frame = await straddling.renderFrame({
			centerLon: centerOnEdge.lon,
			centerLat: centerOnEdge.lat,
			zoom: 12,
			columns: 40,
			rows: 16,
		})

		const rowOffset = 8 * 40

		expect(frame.colors[rowOffset + 5]).toBe(RESIDENTIAL_PACKED)
		expect(frame.colors[rowOffset + 35]).toBe(COMMERCIAL_PACKED)
	})

	it("stamps a marker cell over the map", async () => {
		const frame = await renderer.renderFrame(
			{ centerLon: -122.6023, centerLat: 45.5034, zoom: 14, columns: 21, rows: 11 },
			{ markers: [{ lon: -122.6023, lat: 45.5034 }] }
		)

		// Center cell of an odd-sized viewport is the marker anchor.
		expect(String.fromCodePoint(frame.chars[5 * 21 + 10]!)).toBe("●")
	})

	it("carries the archive attribution", async () => {
		const frame = await renderer.renderFrame({ centerLon: -122.61, centerLat: 45.51, zoom: 11, columns: 20, rows: 10 })
		expect(typeof frame.attribution).toBe("string")
	})
})
