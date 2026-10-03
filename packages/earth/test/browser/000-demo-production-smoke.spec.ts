/**
 * @file Production functional smoke test for the deployed demo. It runs daily against
 *   `MAILWOMAN_EARTH_URL` and in local checks.
 */

import { expect, test } from "../e2e/index.ts"

test.describe("Demo — production functional smoke @smoke", () => {
	test("the basemap requests a vector tile (the tile worker is alive)", async ({ demo, page }) => {
		// Tile requests run inside MapLibre's worker, so this catches a worker that fails silently.
		const tileRequest = page.waitForRequest(/\/basemap-v4\/\d+\/\d+\/\d+\.mvt/, { timeout: 60_000 })
		await demo.goto()

		const request = await tileRequest
		expect(request.url()).toMatch(/\.mvt$/)
		demo.console.assertNoFailEvents()
	})

	test("1600 Pennsylvania Ave NW → address_point rooftop + marker (street tier alive)", async ({ demo }) => {
		await demo.goto("1600 Pennsylvania Ave NW, Washington, DC 20500")
		await demo.submit()

		const { resolved, markerCount, parsedRows } = await demo.readResult()
		expect(parsedRows.length, "parse produced no component rows").toBeGreaterThan(0)
		expect(resolved["placetype"], "degraded off the street tier to admin — the #955 failure mode").toBe("address_point")
		demo.expectNear(await demo.readCoords(), { lat: 38.9, lon: -77.05 }, 0.05)
		expect(markerCount, "no marker rendered").toBeGreaterThan(0)
		demo.console.assertNoFailEvents()
	})

	test("Zabiče 8, 6250 Zabiče → SI locality via the WOF cascade + #942 floor + marker", async ({ demo }) => {
		await demo.goto("Zabiče 8, 6250 Zabiče")
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()
		expect(resolved["placetype"], "the WOF admin cascade returned no hit — the #957/#958 failure mode").toBe("locality")
		demo.expectNear(await demo.readCoords(), { lat: 45.55, lon: 14.35 }, 0.15)
		expect(markerCount, "no marker rendered").toBeGreaterThan(0)
		demo.console.assertNoFailEvents()
	})

	test("1012 LG Amsterdam → resolves in the Netherlands, not Amsterdam NY (#924 / v5.4.0)", async ({ demo }) => {
		await demo.goto("1012 LG Amsterdam")
		await demo.submit()

		const { markerCount } = await demo.readResult()

		demo.expectNear(await demo.readCoords(), { lat: 52.35, lon: 4.9 }, 0.2)
		expect(markerCount, "no marker rendered").toBeGreaterThan(0)
		demo.console.assertNoFailEvents()
	})
})
