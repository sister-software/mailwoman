/**
 * @file Integration probe for the client-side STREET geocoder (#377) — the `verify-httpvfs-street`
 *   probe the unit test (`httpvfs-street.test.ts`) promised but never had a home for.
 *
 *   Drives the real demo against the production R2 situs shard (byte-ranged) and asserts that "1600
 *   Pennsylvania Avenue NW, Washington, DC 20500" resolves to the White House at the
 *   `address_point` (exact building) tier — not the DC admin centroid. This is the marquee: a fully
 *   client-side geocoder that places an exact building from a byte-ranged shard, no server.
 *
 *   The second test guards the byte-range efficiency. It is `test.fixme` until #638 is fixed: the
 *   sql.js-httpvfs `serverMode: "full"` open path currently downloads the ENTIRE shard once to
 *   learn the file length (a redundant 114 MB GET for DC, ~3.2 GB for CA), on top of the efficient
 *   ranged page reads the lookup itself needs. Un-fixme when #638 lands and this passes.
 *
 *   Ground truth (confirmed against the shard): street_norm "pennsylvania avenue northwest", number
 *   1600, postcode 20500 → lat 38.89768, lon -77.03655 (overture:NAD). Postcode disambiguates from
 *   the SE "1600 Pennsylvania" rows.
 *
 *   The browser e2e suite is local/manual (not wired into CI), like `200-demo-resolve.spec.ts`. Run:
 *   `MAILWOMAN_DEMO_URL=http://localhost:7770 yarn test:e2e 250-demo-street-tier`.
 */

import { expect, test } from "#e2e"

const WHITE_HOUSE = { lat: 38.8977, lon: -77.0365 }
const DC_SITUS_BYTES = 119_889_920 // the full shard — a byte-ranged lookup must transfer a tiny fraction

/** Rough metres between two lat/lons (equirectangular; fine at city scale). */
function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const R = 6_371_000
	const dLat = ((b.lat - a.lat) * Math.PI) / 180
	const dLon = ((b.lon - a.lon) * Math.PI) / 180
	const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180)
	const x = dLon * Math.cos(lat)
	return Math.hypot(dLat, x) * R
}

const QUERY = "1600 Pennsylvania Avenue NW, Washington, DC 20500"

test.describe("Demo — street tier (#377)", () => {
	test("White House → exact building (address_point) via the DC situs shard", async ({ demo }) => {
		await demo.goto(QUERY)
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()

		// The street tier fired (exact building), not the WOF admin centroid.
		expect(resolved["placetype"]).toBe("address_point")
		expect(resolved["precision"]).toContain("exact")
		expect(markerCount).toBeGreaterThan(0)

		// The pin lands on the White House (within ~50 m of the known building point).
		const [latStr, lonStr] = (resolved["coords"] ?? "").split(",").map((s) => s.trim())
		const pin = { lat: Number(latStr), lon: Number(lonStr) }
		expect(Number.isFinite(pin.lat) && Number.isFinite(pin.lon)).toBe(true)
		expect(metresBetween(pin, WHITE_HOUSE)).toBeLessThan(50)

		demo.console.assertNoFailEvents()
	})

	// Un-fixme when #638 lands: the open must NOT download the whole shard to learn its length.
	test.fixme("byte-range: a lookup transfers a fraction of the shard, never the whole file (#638)", async ({
		demo,
		page,
	}) => {
		let situsBytes = 0
		let rangeReads = 0
		page.on("response", (res) => {
			if (!res.url().includes("/street/us/dc/situs.db")) return
			if (res.status() === 206) rangeReads++
			situsBytes += Number(res.headers()["content-length"] ?? 0)
		})

		await demo.goto(QUERY)
		await demo.submit()
		await demo.readResult()

		expect(rangeReads).toBeGreaterThan(0)
		expect(situsBytes).toBeLessThan(DC_SITUS_BYTES / 10) // a few MB, not the whole 114 MB
	})
})
