/**
 * @file Production functional-smoke — the check the 2026-07-04 demo triple outage went missing for.
 *
 *   `version-parity.yml` confirmed the demo's PINNED VERSION tracked npm, and stayed green for three
 *   days while the demo served no WOF hits, no FST, and no street tier — version parity is not
 *   functional parity. Every one of those three failures produced zero console errors; the only
 *   symptom was degraded results. So this smoke grades the RESULTS, not the absence of errors.
 *
 *   Tagged `@smoke`: `demo-smoke.yml` runs THIS spec (and only this) against the deployed site daily
 *   via `MAILWOMAN_DEMO_URL`. It also runs in the local build gate like every other browser spec, so
 *   a refactor that breaks the cascade fails in CI before it ships. Two addresses, chosen to light up
 *   all three tiers at once:
 *     - 1600 Pennsylvania Ave NW → the STREET tier (situs/interp shards) + an address_point rooftop.
 *     - Zabiče 8, 6250 Zabiče   → the WOF admin cascade AND the #942/#961 postal-compound floor.
 *   If either regresses to admin-only (or drops its marker), a tier is dead — exactly what shipped
 *   silently before.
 */

import { expect, test } from "#e2e"

test.describe("Demo — production functional smoke @smoke", () => {
	test("1600 Pennsylvania Ave NW → address_point rooftop + marker (street tier alive)", async ({ demo }) => {
		await demo.goto("1600 Pennsylvania Ave NW, Washington, DC 20500")
		await demo.submit()

		const { resolved, markerCount, parsedRows } = await demo.readResult()
		expect(parsedRows.length, "parse produced no component rows").toBeGreaterThan(0)
		expect(resolved["placetype"], "degraded off the street tier to admin — the #955 failure mode").toBe(
			"address_point"
		)
		const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
		expect(lat, `resolved lat ${lat} should be at the White House`).toBeGreaterThan(38.85)
		expect(lat).toBeLessThan(38.95)
		expect(lon).toBeGreaterThan(-77.1)
		expect(lon).toBeLessThan(-77.0)
		expect(markerCount, "no marker rendered").toBeGreaterThan(0)
		demo.console.assertNoFailEvents()
	})

	test("Zabiče 8, 6250 Zabiče → SI locality via the WOF cascade + #942 floor + marker", async ({ demo }) => {
		await demo.goto("Zabiče 8, 6250 Zabiče")
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()
		expect(resolved["placetype"], "the WOF admin cascade returned no hit — the #957/#958 failure mode").toBe(
			"locality"
		)
		const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
		expect(lat, `resolved lat ${lat} should be in Slovenia`).toBeGreaterThan(45.4)
		expect(lat).toBeLessThan(45.7)
		expect(lon, `resolved lon ${lon} should be in Slovenia`).toBeGreaterThan(14.2)
		expect(lon).toBeLessThan(14.5)
		expect(markerCount, "no marker rendered").toBeGreaterThan(0)
		demo.console.assertNoFailEvents()
	})
})
