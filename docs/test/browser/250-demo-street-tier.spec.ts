/**
 * @file Integration probe for the client-side STREET geocoder (#377) — the `verify-httpvfs-street` probe the unit test
 *   (`httpvfs-street.test.ts`) promised but never had a home for. Drives the real demo against the production R2 situs
 *   extract (byte-ranged) and asserts that "1600 Pennsylvania Avenue NW, Washington, DC 20500" resolves to the White
 *   House at the `address_point` (exact building) tier — not the DC admin centroid. This is the marquee: a fully
 *   client-side geocoder that places an exact building from a byte-ranged extract, no server. The second test guards
 *   the byte-range efficiency: a lookup must transfer a tiny fraction of the extract, never the whole file. It counts
 *   only GET response bodies — sql.js-httpvfs's `serverMode: "full"` open does ONE `HEAD` to learn the file length (the
 *   length-discovery probe), and a HEAD's `content-length` reports the full size but transfers ZERO bytes; summing it
 *   was the #638 false-alarm (the original report + an earlier version of this guard counted the HEAD as a 114 MB
 *   download). Measured against prod: 1 HEAD (0 bytes) + ~5 ranged 206 reads ≈ 280 KB of the 114 MB extract. There is
 *   no full-extract download — #638 was a measurement artifact, closed not fixed. Ground truth (confirmed against the
 *   extract): street_norm "pennsylvania avenue northwest", number 1600, postcode 20500 → lat 38.89768, lon -77.03655
 *   (overture:NAD). Postcode disambiguates from the SE "1600 Pennsylvania" rows. The browser e2e suite is local/manual
 *   (not wired into CI), like `200-demo-resolve.spec.ts`. Run: `MAILWOMAN_DEMO_URL=http://localhost:7770 yarn test:e2e
 *   250-demo-street-tier`.
 */

import { haversineKm } from "@mailwoman/spatial"

import { expect, test } from "#e2e"

const WHITE_HOUSE = { lat: 38.8977, lon: -77.0365 }
const DC_SITUS_BYTES = 119_889_920

// the full extract — a byte-ranged lookup must transfer a tiny fraction

const QUERY = "1600 Pennsylvania Avenue NW, Washington, DC 20500"

test.describe("Demo — street tier (#377)", () => {
	test("White House → exact building (address_point) via the DC situs extract", async ({ demo }) => {
		await demo.goto(QUERY)
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()

		// The street tier fired (exact building), not the WOF admin centroid.
		expect(resolved["placetype"]).toBe("address_point")
		expect(resolved["precision"]).toContain("exact")
		expect(markerCount).toBeGreaterThan(0)

		// The pin lands on the White House (within ~50 m of the known building point).
		const pin = await demo.readCoords()
		expect(Number.isFinite(pin.lat) && Number.isFinite(pin.lon)).toBe(true)
		expect(haversineKm(pin.lat, pin.lon, WHITE_HOUSE.lat, WHITE_HOUSE.lon) * 1000).toBeLessThan(50)

		demo.console.assertNoFailEvents()
	})

	// Un-fixme when #638 lands: the open must NOT download the whole extract to learn its length.
	test("byte-range: a lookup transfers a fraction of the extract, never the whole file (#638)", async ({
		demo,
		page,
	}) => {
		let situsBytes = 0
		let rangeReads = 0

		page.on("response", (res) => {
			if (!res.url().includes("/street/us/dc/situs.db")) return

			// Only GET responses transfer a body. A HEAD (sql.js-httpvfs's length probe on open) carries
			// the full file size in `content-length` but transfers ZERO bytes — counting it would falsely
			// read as a whole-extract download (the #638 measurement trap). The 206 page reads are the lookup.
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
		expect(situsBytes).toBeLessThan(DC_SITUS_BYTES / 10) // a few MB of ranged reads, not the whole 114 MB
	})
})
