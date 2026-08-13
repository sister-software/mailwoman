/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { frameToANSILines } from "./frame.ts"
import { MapRenderer } from "./renderer.ts"
import { TileSource } from "./tile-source.ts"

const FIXTURE = fileURLToPath(new URL("./test/fixtures/portland.pmtiles", import.meta.url))

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
