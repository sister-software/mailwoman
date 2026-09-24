/**
 * @file Check the client-side street geocoder against the production R2 situs extract.
 *   The White House query must resolve to its exact `address_point`, not the DC centroid. A second test verifies that
 *   the lookup transfers only ranged response bodies. The HEAD request discovers file size but transfers no body;
 *   counting its `content-length` caused the #638 false alarm. Production measured about 280 KB across five range reads
 *   from a 114 MB extract. Ground truth from the extract: `pennsylvania avenue northwest`, 1600, postcode 20500 →
 *   38.89768, -77.03655 (overture:NAD); the postcode distinguishes nearby southeast records. This suite is local/manual.
 */

import { haversineKm } from "@mailwoman/spatial"

import { expect, test } from "../e2e/index.ts"

const WHITE_HOUSE = { lat: 38.8977, lon: -77.0365 }
const DC_SITUS_BYTES = 119_889_920

// Ensure a lookup transfers only a small fraction of the extract.

const QUERY = "1600 Pennsylvania Avenue NW, Washington, DC 20500"

test.describe("Demo — street tier (#377)", () => {
	test("White House → exact building (address_point) via the DC situs extract", async ({ demo }) => {
		await demo.goto(QUERY)
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()

		// Confirm the exact-building street tier, not the WOF centroid.
		expect(resolved["placetype"]).toBe("address_point")
		expect(resolved["precision"]).toContain("exact")
		expect(markerCount).toBeGreaterThan(0)

		// Require the pin to fall within 50 m of the known building point.
		const pin = await demo.readCoords()
		expect(Number.isFinite(pin.lat) && Number.isFinite(pin.lon)).toBe(true)
		expect(haversineKm(pin.lat, pin.lon, WHITE_HOUSE.lat, WHITE_HOUSE.lon) * 1000).toBeLessThan(50)

		demo.console.assertNoFailEvents()
	})

	// Guard against downloading the full extract during a lookup.
	test("byte-range: a lookup transfers a fraction of the extract, never the whole file (#638)", async ({
		demo,
		page,
	}) => {
		let situsBytes = 0
		let rangeReads = 0

		page.on("response", (res) => {
			if (!res.url().includes("/street/us/dc/situs.db")) return

			// Count GET bodies only: HEAD reports the full size but transfers no bytes.
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
		expect(situsBytes).toBeLessThan(DC_SITUS_BYTES / 10) // Under one tenth of the extract.
	})
})
