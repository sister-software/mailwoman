// National US rooftop rollout (#735) gate: with the 50-state situs/interp shards hosted, an address
// in a newly-rolled state must resolve to its BUILDING (the situs `address_point` coord), not the
// WOF admin city-centroid (km away). Each case is a real row pulled from that state's situs shard, so
// the truth coord IS the shard's coord; we grade the assembled coordinate within ~500 m (tight enough
// to distinguish rooftop from a centroid fallback, loose enough for any normalization). Representative
// spread: TX/GA/WA urban + MT rural.
import { expect, test } from "#e2e"

const TOL = 0.006 // ~600 m

const CASES: Array<{ state: string; address: string; lat: number; lon: number }> = [
	{ state: "TX", address: "1502 A Cage Street, Houston, TX 77020", lat: 29.7747, lon: -95.335 },
	{ state: "GA", address: "1705 Adolphus Street, Atlanta, GA 30307", lat: 33.7636, lon: -84.3317 },
	{ state: "WA", address: "1211 Aloha Street, Seattle, WA 98109", lat: 47.6266, lon: -122.332 },
	{ state: "MT", address: "1910 Arch Stone Street, Billings, MT 59106", lat: 45.7896, lon: -108.6547 },
]

test.describe("Demo — national US rooftop (#735)", () => {
	for (const c of CASES) {
		test(`${c.state}: ${c.address} resolves to the building (situs), not the city centroid`, async ({ demo }) => {
			await demo.goto(c.address)
			await demo.submit()
			const { resolved, markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
			expect(lat, `resolved lat ${lat} should be the ${c.state} building (~${c.lat})`).toBeGreaterThan(c.lat - TOL)
			expect(lat).toBeLessThan(c.lat + TOL)
			expect(lon, `resolved lon ${lon} should be the ${c.state} building (~${c.lon})`).toBeGreaterThan(c.lon - TOL)
			expect(lon).toBeLessThan(c.lon + TOL)
			demo.console.assertNoFailEvents()
		})
	}
})
