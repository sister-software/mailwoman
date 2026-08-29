/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readAttribution, TileSource } from "@mailwoman/map-tui/tile-source"
import { readFile } from "@mailwoman/platform/fs/promises"
import { createServer } from "@mailwoman/platform/http"
import type { AddressInfo } from "@mailwoman/platform/net"
import { fileURLToPath } from "@mailwoman/platform/url"
import { afterAll, describe, expect, it } from "vitest"

const FIXTURE = fileURLToPath(new URL("../fixtures/portland.pmtiles", import.meta.url))

describe("TileSource", async () => {
	const source = await TileSource.open(FIXTURE)

	afterAll(() => source.close())

	it("reads header zoom bounds", () => {
		expect(source.minZoom).toBe(0)
		expect(source.maxZoom).toBeGreaterThanOrEqual(14)
	})

	it("carries no attribution for the synthetic fixture — absent metadata reads as empty, not unknown", () => {
		expect(source.attribution).toBe("")
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

describe("TileSource over HTTP", async () => {
	// A minimal static server honoring single Range requests — all a remote PMTiles archive requires of its host.
	const fixture = await readFile(FIXTURE)

	const server = createServer((request, response) => {
		const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? "")

		if (!range) {
			response.writeHead(200, { "content-length": fixture.byteLength })
			response.end(fixture)

			return
		}

		const start = Number(range[1])
		const end = Math.min(Number(range[2]), fixture.byteLength - 1)

		response.writeHead(206, {
			"content-range": `bytes ${start}-${end}/${fixture.byteLength}`,
			"content-length": end - start + 1,
		})

		response.end(fixture.subarray(start, end + 1))
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})

	const { port } = server.address() as AddressInfo
	const source = await TileSource.open(`http://127.0.0.1:${port}/portland.pmtiles`)

	afterAll(async () => {
		await source.close()

		await new Promise((resolve) => {
			server.close(resolve)
		})
	})

	it("reads the same header bounds as the local file", () => {
		expect(source.minZoom).toBe(0)
		expect(source.maxZoom).toBeGreaterThanOrEqual(14)
	})

	it("fetches SE Clinton St through range requests", async () => {
		const tile = await source.getTile(14, 2612, 5861)
		const roads = tile!.layers.find((layer) => layer.name === "roads")
		const named = roads!.features.map((f) => f.properties["name"]).filter(Boolean)

		expect(named).toContain("SE Clinton St")
	})
})

describe("readAttribution", () => {
	it("strips tags and decodes entities to plain terminal text", () => {
		expect(
			readAttribution({ attribution: '<a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap</a>' })
		).toBe("© OpenStreetMap")
	})

	it("decodes the full named-entity set, HTML5 legacy rules included", () => {
		expect(readAttribution({ attribution: "&copy; Foo &odot; Bar" })).toBe("© Foo ⊙ Bar")
		// The HTML5 legacy set decodes WITHOUT a semicolon, so a prefix-matching token is not "unknown":
		expect(readAttribution({ attribution: "&notarealentity;" })).toBe("¬arealentity;")
		expect(readAttribution({ attribution: "&zzznotanentity; stays raw" })).toBe("&zzznotanentity; stays raw")
	})

	it("reads absent or malformed metadata as empty", () => {
		expect(readAttribution(null)).toBe("")
		expect(readAttribution({ attribution: 7 })).toBe("")
	})
})
