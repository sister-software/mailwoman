/**
 * @file Tests the client-side street geocoder against the production R2 situs extract. Run it locally.
 */

import { haversineKm } from "@mailwoman/spatial"

import { expect, test } from "../e2e/index.ts"

// The extract's point for 1600 Pennsylvania Avenue NW, postcode 20500.
const WHITE_HOUSE = { lat: 38.8977, lon: -77.0365 }
const DC_SITUS_BYTES = 119_889_920

const QUERY = "1600 Pennsylvania Avenue NW, Washington, DC 20500"

test.describe("Demo — street tier (#377)", () => {
	test("White House → exact building (address_point) via the DC situs extract", async ({ demo }) => {
		await demo.goto(QUERY)
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()

		// The street tier returns the exact building point.
		expect(resolved["placetype"]).toBe("address_point")
		expect(resolved["precision"]).toContain("exact")
		expect(markerCount).toBeGreaterThan(0)

		const pin = await demo.readCoords()
		expect(Number.isFinite(pin.lat) && Number.isFinite(pin.lon)).toBe(true)
		expect(haversineKm(pin.lat, pin.lon, WHITE_HOUSE.lat, WHITE_HOUSE.lon) * 1000).toBeLessThan(50)

		demo.console.assertNoFailEvents()
	})

	test("byte-range: a lookup transfers a fraction of the extract, never the whole file (#638)", async ({
		demo,
		page,
	}) => {
		let situsBytes = 0
		let rangeReads = 0

		page.on("response", (res) => {
			if (!res.url().includes("/street/us/dc/situs.db")) return

			// A HEAD response reports the full file size in `content-length` but has no body, so only GET counts.
			if (res.request().method() !== "GET") return

			if (res.status() === 206) {
				rangeReads++
			}

			situsBytes += Number(res.headers()["content-length"] ?? 0)
		})

		await demo.goto(QUERY)
		await demo.submit()
		await demo.readResult()

		expect(rangeReads).toBeGreaterThan(0)
		expect(situsBytes).toBeLessThan(DC_SITUS_BYTES / 10)
	})
})
