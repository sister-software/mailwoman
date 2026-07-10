// FR national rooftop (#1012 + the 2026-07-10 chevaleret closure): with the BAN situs shard hosted
// (street/fr/national/situs.db) and the demo's national street-tier fallback wired, a postcode-less
// FR street address must resolve to its BAN rooftop point, not the Paris admin centroid (~5 km off).
// The truth coord IS the shard's row (arrondissement communes fold to the base city on both sides,
// so the bare "Paris" locality probe hits directly). Guards: the national fallback slug dispatch,
// the fr street-key locale, the commune fold, and the hosted artifact — any one missing falls back
// to the admin centroid and fails the tolerance.
import { expect, test } from "#e2e"

const TOL = 0.006 // ~600 m — separates the rooftop (48.8335) from the Paris centroid (48.8566)

const CASES: Array<{ address: string; lat: number; lon: number }> = [
	// BAN row: 181 | rue du chevaleret | 75013 | paris → 48.833518, 2.36858 (release 2026-05-18)
	{ address: "181 Rue du Chevaleret, Paris", lat: 48.833518, lon: 2.36858 },
	// The WITH-postcode form must keep hitting the same row via the postcode probe.
	{ address: "181 Rue du Chevaleret, 75013 Paris", lat: 48.833518, lon: 2.36858 },
]

test.describe("Demo — FR national rooftop (BAN)", () => {
	for (const c of CASES) {
		test(`${c.address} resolves to the BAN rooftop, not the commune centroid`, async ({ demo }) => {
			await demo.goto(c.address)
			await demo.submit()
			const { resolved, markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
			expect(lat, `resolved lat ${lat} should be the rooftop (~${c.lat})`).toBeGreaterThan(c.lat - TOL)
			expect(lat).toBeLessThan(c.lat + TOL)
			expect(lon, `resolved lon ${lon} should be the rooftop (~${c.lon})`).toBeGreaterThan(c.lon - TOL)
			expect(lon).toBeLessThan(c.lon + TOL)
			demo.console.assertNoFailEvents()
		})
	}
})
