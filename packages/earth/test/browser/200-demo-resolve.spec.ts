import { expect, test } from "../e2e/index.ts"

test.describe("Demo — resolution cascade", () => {
	// Every step queries a fresh address on a single page load, because the in-browser init
	// (ONNX + sqlite-wasm + gazetteer warm-up) dominates the suite's wall time.
	// These cascade assertions are independent of load state.
	// `submitForUpdate` waits for the result panel to replace the previous step's rows.
	test("city resolution cascade — one page load, one step per address", async ({ demo }) => {
		await test.step("Chicago, IL → resolves to the Chicago locality", async () => {
			// A `?q=` link runs its query on load and fits the map to the result.
			// A second submit would then be biased toward that result's view,
			// so the query is entered on a fresh page.
			await demo.goto()
			await demo.setAddress("Chicago, IL")
			await demo.submit()

			const { resolved, markerCount, parsedRows } = await demo.readResult()
			expect(parsedRows.length).toBeGreaterThan(0)
			expect(resolved["name"]).toBe("Chicago")
			expect(resolved["placetype"]).toBe("locality")
			expect(markerCount).toBeGreaterThan(0)
		})

		await test.step("German address — postcode 10115 country-restricts into Berlin rather than New York", async () => {
			// Regression for the candidate cascade: 10115 is a Berlin postcode and a New York ZIP.
			// The gazetteer now includes US + DE/FR/EU postcodes.
			// The locality must resolve first (Berlin → DE by population) and country-restrict
			// the postcode, so it resolves to the DE 10115 point — IN Berlin — never the NYC ZIP.
			// Grade the coordinate (postcode-precise now): Berlin ≈ 52.5, 13.4
			// rather than Manhattan ≈ 40.8, -74.0.
			await demo.setAddress("5 Hauptstraße, Berlin, Berlin 10115")
			await demo.submitForUpdate()

			const { markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			demo.expectNear(await demo.readCoords(), { lat: 52.5, lon: 13.4 }, 0.4)
		})

		await test.step("Canadian address — postcode M5H 2N2 resolves into Toronto (the -20f CA coverage)", async () => {
			// -20f folds Canada's Overture divisions into the admin gazetteer
			// (Toronto, Montréal, … — absent before) plus 843k CA postcode centroids.
			// "Toronto" resolves to Ontario (top by population).
			// The cascade restricts the country to CA.
			// The CA postcode is then reachable.
			// Grade the coordinate: downtown Toronto ≈ 43.6, -79.4 rather than Toronto,
			// Ohio (40.46), where it landed pre-CA-admin.
			await demo.setAddress("100 Queen Street West, Toronto, ON M5H 2N2")
			await demo.submitForUpdate()

			const { markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			demo.expectNear(await demo.readCoords(), { lat: 43.7, lon: -79.4 }, 0.3)
		})

		await test.step("Russian address — Moscow resolves to Russia rather than Moscow, Idaho (-20g world coverage)", async () => {
			// -20g folds ~70 countries' Overture divisions + GeoNames population + multilingual aliases.
			// The English "Moscow" (an alias of Москва) resolves.
			// The 10.4M-pop RU city outranks the 26k-pop US homonym.
			// Grade the coordinate: Moscow ≈ 55.7, 37.6 rather than Idaho (46.7, -117).
			await demo.setAddress("Moscow, Russia")
			await demo.submitForUpdate()

			const { markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			demo.expectNear(await demo.readCoords(), { lat: 55.7, lon: 37.6 }, 0.4)
		})

		await test.step("Egyptian address — Cairo resolves to Egypt via its English alias (-20g)", async () => {
			// Cairo's Overture primary is القاهرة; the en alias + GeoNames population (9.6M) put it on the map.
			await demo.setAddress("Cairo, Egypt")
			await demo.submitForUpdate()

			const { markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			demo.expectNear(await demo.readCoords(), { lat: 30.05, lon: 31.3 }, 0.35)
		})

		await test.step("Australian address — Sydney resolves to NSW (-20g Latin-primary coverage)", async () => {
			await demo.setAddress("Sydney, NSW, Australia")
			await demo.submitForUpdate()

			const { markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			demo.expectNear(await demo.readCoords(), { lat: -33.9, lon: 151.15 }, 0.4)
		})

		demo.console.assertNoFailEvents()
	})

	test("ZIP-only example drops a marker", async ({ demo }) => {
		await demo.goto()
		await demo.clickExample("ZIP only")
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()
		// 90210 is the example.
		// Should land somewhere in CA.
		// The cascade may resolve via postcode or fall back to locality if the postcode has placeholder coords.
		// Either way: a marker.
		expect(markerCount).toBeGreaterThan(0)
		expect(resolved["coords"]).toBeTruthy()
		demo.console.assertNoFailEvents()
	})

	// -20j (2026-06-24a) adds postcodes for PT/PL/CZ/AU — absent from the prior -20h build,
	// so these countries had no postcode tier on the demo at all.
	// Each case feeds locality + postcode + country and grades the resolved coordinate against the
	// city bbox: the cascade country-restricts and the new postcode (or its locality) is reachable.
	// Pairs with the v4.14.0 AU model (postcode-first format).
	const newPostcodeCases: {
		name: string
		query: string
		lat: number
		lon: number
		tolDeg: number
		/**
		 * A measured defect the case documents until it is fixed.
		 * The test is expected to fail while it stands.
		 */
		knownFailure?: string
	}[] = [
		{
			name: "Portuguese postcode 1000-001 → Lisbon",
			query: "Lisboa 1000-001, Portugal",
			lat: 38.75,
			lon: -9.15,
			tolDeg: 0.15,
		},
		{ name: "Polish postcode 00-002 → Warsaw", query: "Warszawa 00-002, Poland", lat: 52.25, lon: 21.05, tolDeg: 0.15 },
		{
			name: "Czech postcode 100 00 → Prague",
			query: "Praha 100 00, Czechia",
			lat: 50.05,
			lon: 14.45,
			tolDeg: 0.15,
		},
		{
			name: "Australian postcode 2000 → Sydney",
			query: "Sydney NSW 2000, Australia",
			lat: -33.85,
			lon: 151.2,
			tolDeg: 0.2,
		},
		{
			// The Han input loads the character family's bundle.
			// That bundle labels the municipality 渋谷区 for the cascade.
			// When the cascade finds no place, the postcode-only fallback answers the Who's On
			// First centroid of 150-0043 (Dōgenzaka, Shibuya) from the release's `postcode-jp.bin`.
			// The browser gazetteer holds no Japanese postcode rows.
			// Both paths land inside the tolerance.
			name: "Japanese postcode 〒150-0043 → Shibuya",
			query: "〒150-0043 東京都渋谷区道玄坂1丁目",
			lat: 35.657,
			lon: 139.695,
			tolDeg: 0.05,
		},
	]

	// Cases with a knownFailure keep their own test so `test.fail` scopes to the one case.
	const knownFailureCases = newPostcodeCases.filter((c) => c.knownFailure)
	const passingCases = newPostcodeCases.filter((c) => !c.knownFailure)

	// One page load for every passing case, as in the city cascade above.
	test("-20j postcode coverage — one page load, one step per postcode", async ({ demo }) => {
		const [firstCase, ...restCases] = passingCases
		test.skip(!firstCase, "every -20j case currently documents a known failure")

		if (!firstCase) return

		await test.step(firstCase.name, async () => {
			await demo.goto(firstCase.query)
			await demo.submit()

			const { markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			demo.expectNear(await demo.readCoords(), { lat: firstCase.lat, lon: firstCase.lon }, firstCase.tolDeg)
		})

		for (const c of restCases) {
			await test.step(c.name, async () => {
				await demo.setAddress(c.query)
				await demo.submitForUpdate()

				const { markerCount } = await demo.readResult()
				expect(markerCount).toBeGreaterThan(0)
				demo.expectNear(await demo.readCoords(), { lat: c.lat, lon: c.lon }, c.tolDeg)
			})
		}

		demo.console.assertNoFailEvents()
	})

	for (const c of knownFailureCases) {
		test(`-20j postcode coverage — ${c.name}`, async ({ demo }) => {
			test.fail(true, c.knownFailure ?? "")

			await demo.goto(c.query)
			await demo.submit()
			const { markerCount } = await demo.readResult()
			expect(markerCount).toBeGreaterThan(0)
			demo.expectNear(await demo.readCoords(), { lat: c.lat, lon: c.lon }, c.tolDeg)
			demo.console.assertNoFailEvents()
		})
	}

	test("White House default — surfaces no fail-pattern errors even when resolver returns nothing", async ({ demo }) => {
		// Postcode 20500 has lat=0/lon=0 in WOF.
		// Cascade filters it.
		// Raw text + locality may also miss.
		// The test isn't asserting the resolution succeeds.
		// It's asserting that the "Style is not done loading" race + bbox-on-empty-result paths stay clean.
		await demo.goto()
		await demo.submit()
		demo.console.assertNoFailEvents()
	})
})
