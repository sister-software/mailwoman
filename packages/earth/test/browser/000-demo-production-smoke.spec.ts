/**
 * @file Production functional smoke test for the deployed demo.
 *   Version parity alone did not catch the 2026-07-04 outage: WOF, FST, and street-tier failures produced no console
 *   errors. This `@smoke` spec checks results and runs daily against `MAILWOMAN_EARTH_URL`, as well as in local checks.
 *   Its addresses exercise the resolver tiers:
 *
 *   - 1600 Pennsylvania Ave NW → the street tier (situs/interp extracts) + an address_point rooftop.
 *   - Zabiče 8, 6250 Zabiče → the WOF admin cascade and the #942/#961 postal-compound floor. If either regresses to
 *     admin-only (or drops its marker), a tier is dead — exactly what shipped silently before.
 *   - 1012 LG Amsterdam → the #924 NL digits-first postcode fix (v5.4.0). If the model regresses to parsing `1012` as a
 *     house number + `LG` as a street, the spurious street context drags it to the US situs tier (Amsterdam, NY) — so
 *     this asserts the coordinate lands in the netherlands, the exact bug v5.4.0 shipped to fix.
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

		// Distinguish Amsterdam, Netherlands (~52.37, 4.90) from the pre-v5.4.0 result in New York (~42.94, -74.19).
		demo.expectNear(await demo.readCoords(), { lat: 52.35, lon: 4.9 }, 0.2)
		expect(markerCount, "no marker rendered").toBeGreaterThan(0)
		demo.console.assertNoFailEvents()
	})
})
