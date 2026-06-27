import { expect, test } from "#e2e"

test.describe("Demo — resolution cascade", () => {
	test("Chicago, IL → resolves to the Chicago locality", async ({ demo }) => {
		await demo.goto("Chicago, IL")
		await demo.submit()

		const { resolved, markerCount, parsedRows } = await demo.readResult()
		expect(parsedRows.length).toBeGreaterThan(0)
		expect(resolved["name"]).toBe("Chicago")
		expect(resolved["placetype"]).toBe("locality")
		expect(markerCount).toBeGreaterThan(0)
		demo.console.assertNoFailEvents()
	})

	test("ZIP-only example drops a marker", async ({ demo }) => {
		await demo.goto()
		await demo.clickExample("ZIP only")
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()
		// 90210 is the example; should land somewhere in CA. The cascade may resolve via postcode
		// or fall back to locality if the postcode has placeholder coords. Either way: a marker.
		expect(markerCount).toBeGreaterThan(0)
		expect(resolved["coords"]).toBeTruthy()
		demo.console.assertNoFailEvents()
	})

	test("German address — postcode 10115 country-gates into Berlin, not New York", async ({ demo }) => {
		// Regression for the candidate-table cascade: 10115 is both a Berlin DE postcode and a New York US
		// ZIP, and the gazetteer now carries US + DE/FR/EU postcodes. The locality must resolve first
		// (Berlin → DE by population) and country-gate the postcode, so it resolves to the DE 10115 point —
		// IN Berlin — never the NYC ZIP. Grade the COORDINATE (postcode-precise now): Berlin ≈ 52.5, 13.4,
		// not Manhattan ≈ 40.8, -74.0.
		await demo.goto("5 Hauptstraße, Berlin, Berlin 10115")
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()
		expect(markerCount).toBeGreaterThan(0)
		const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
		expect(lat, `resolved lat ${lat} should be in Berlin`).toBeGreaterThan(52.3)
		expect(lat).toBeLessThan(52.7)
		expect(lon, `resolved lon ${lon} should be in Berlin`).toBeGreaterThan(13.0)
		expect(lon).toBeLessThan(13.8)
		demo.console.assertNoFailEvents()
	})

	test("Canadian address — postcode M5H 2N2 resolves into Toronto (the -20f CA coverage)", async ({ demo }) => {
		// -20f folds Canada's Overture divisions into the admin gazetteer (Toronto, Montréal, … — absent
		// before) PLUS 843k CA postcode centroids. So "Toronto" resolves to Ontario (top by population),
		// the cascade country-gates to CA, and the CA postcode is reachable. Grade the COORDINATE:
		// downtown Toronto ≈ 43.6, -79.4 — not Toronto, Ohio (40.46), where it landed pre-CA-admin.
		await demo.goto("100 Queen Street West, Toronto, ON M5H 2N2")
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()
		expect(markerCount).toBeGreaterThan(0)
		const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
		expect(lat, `resolved lat ${lat} should be in Toronto`).toBeGreaterThan(43.5)
		expect(lat).toBeLessThan(43.9)
		expect(lon, `resolved lon ${lon} should be in Toronto`).toBeGreaterThan(-79.7)
		expect(lon).toBeLessThan(-79.1)
		demo.console.assertNoFailEvents()
	})

	test("Russian address — Moscow resolves to Russia, not Moscow, Idaho (-20g world coverage)", async ({ demo }) => {
		// -20g folds ~70 countries' Overture divisions + GeoNames population + multilingual aliases. So
		// the English "Moscow" (an alias of Москва) resolves, and the 10.4M-pop RU city outranks the
		// 26k-pop US homonym. Grade the COORDINATE: Moscow ≈ 55.7, 37.6 — not Idaho (46.7, -117).
		await demo.goto("Moscow, Russia")
		await demo.submit()
		const { resolved, markerCount } = await demo.readResult()
		expect(markerCount).toBeGreaterThan(0)
		const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
		expect(lat, `resolved lat ${lat} should be Moscow RU`).toBeGreaterThan(55.3)
		expect(lat).toBeLessThan(56.1)
		expect(lon).toBeGreaterThan(37.2)
		expect(lon).toBeLessThan(38.0)
		demo.console.assertNoFailEvents()
	})

	test("Egyptian address — Cairo resolves to Egypt via its English alias (-20g)", async ({ demo }) => {
		// Cairo's Overture primary is القاهرة; the en alias + GeoNames population (9.6M) put it on the map.
		await demo.goto("Cairo, Egypt")
		await demo.submit()
		const { resolved, markerCount } = await demo.readResult()
		expect(markerCount).toBeGreaterThan(0)
		const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
		expect(lat, `resolved lat ${lat} should be Cairo EG`).toBeGreaterThan(29.7)
		expect(lat).toBeLessThan(30.4)
		expect(lon).toBeGreaterThan(31.0)
		expect(lon).toBeLessThan(31.6)
		demo.console.assertNoFailEvents()
	})

	test("Australian address — Sydney resolves to NSW (-20g Latin-primary coverage)", async ({ demo }) => {
		await demo.goto("Sydney, NSW, Australia")
		await demo.submit()
		const { resolved, markerCount } = await demo.readResult()
		expect(markerCount).toBeGreaterThan(0)
		const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
		expect(lat, `resolved lat ${lat} should be Sydney AU`).toBeGreaterThan(-34.3)
		expect(lat).toBeLessThan(-33.5)
		expect(lon).toBeGreaterThan(150.8)
		expect(lon).toBeLessThan(151.5)
		demo.console.assertNoFailEvents()
	})

	// -20j (2026-06-24a) adds postcodes for PT/PL/CZ/AU — absent from the prior -20h build, so these
	// countries had no postcode tier on the demo at all. Each case feeds locality + postcode + country
	// and grades the resolved coordinate against the city bbox: the cascade country-gates and the new
	// postcode (or its locality) is reachable. Pairs with the v4.14.0 AU model (postcode-first format).
	const newPostcodeCases: { name: string; query: string; lat: [number, number]; lon: [number, number] }[] = [
		{
			name: "Portuguese postcode 1000-001 → Lisbon",
			query: "Lisboa 1000-001, Portugal",
			lat: [38.6, 38.9],
			lon: [-9.3, -9.0],
		},
		{ name: "Polish postcode 00-002 → Warsaw", query: "Warszawa 00-002, Poland", lat: [52.1, 52.4], lon: [20.9, 21.2] },
		{ name: "Czech postcode 100 00 → Prague", query: "Praha 100 00, Czechia", lat: [49.9, 50.2], lon: [14.3, 14.6] },
		{
			name: "Australian postcode 2000 → Sydney",
			query: "Sydney NSW 2000, Australia",
			lat: [-34.0, -33.7],
			lon: [151.0, 151.4],
		},
	]
	for (const c of newPostcodeCases) {
		test(`-20j postcode coverage — ${c.name}`, async ({ demo }) => {
			await demo.goto(c.query)
			await demo.submit()
			const { resolved, markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			const [lat, lon] = (resolved["coords"] ?? "").split(",").map((s) => Number.parseFloat(s.trim()))
			expect(lat, `resolved lat ${lat} for "${c.query}"`).toBeGreaterThan(c.lat[0])
			expect(lat).toBeLessThan(c.lat[1])
			expect(lon, `resolved lon ${lon} for "${c.query}"`).toBeGreaterThan(c.lon[0])
			expect(lon).toBeLessThan(c.lon[1])
			demo.console.assertNoFailEvents()
		})
	}

	test("White House default — surfaces no fail-pattern errors even when resolver returns nothing", async ({ demo }) => {
		// Postcode 20500 has lat=0/lon=0 in WOF; cascade filters it; raw text + locality may also
		// miss. The test isn't asserting the resolution succeeds — it's asserting that the
		// "Style is not done loading" race + bbox-on-empty-result paths stay clean.
		await demo.goto()
		await demo.submit()
		demo.console.assertNoFailEvents()
	})
})
