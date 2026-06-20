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

	test("German address — postcode 10115 country-gates to Berlin, not New York", async ({ demo }) => {
		// Regression for the candidate-table cascade: 10115 is both a Berlin DE postcode and a New York US
		// ZIP, and the gazetteer carries US postcodes only. Postcode-first-unconstrained used to short-
		// circuit to NYC. The locality must resolve first (Berlin → DE by population) and country-gate the
		// postcode, landing the result in Berlin.
		await demo.goto("5 Hauptstraße, Berlin, Berlin 10115")
		await demo.submit()

		const { resolved, markerCount } = await demo.readResult()
		expect(markerCount).toBeGreaterThan(0)
		expect(resolved["name"]).toBe("Berlin")
		expect(resolved["placetype"]).toBe("locality")
		demo.console.assertNoFailEvents()
	})

	test("White House default — surfaces no fail-pattern errors even when resolver returns nothing", async ({ demo }) => {
		// Postcode 20500 has lat=0/lon=0 in WOF; cascade filters it; raw text + locality may also
		// miss. The test isn't asserting the resolution succeeds — it's asserting that the
		// "Style is not done loading" race + bbox-on-empty-result paths stay clean.
		await demo.goto()
		await demo.submit()
		demo.console.assertNoFailEvents()
	})
})
