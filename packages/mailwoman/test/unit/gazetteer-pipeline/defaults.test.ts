import {
	DEFAULT_GEONAMES_COUNTRIES,
	DEFAULT_OVERTURE_COUNTRIES,
	DEFAULT_WOF_PRIORITY_COUNTRIES,
	geonamesAdminGapCountries,
} from "mailwoman/gazetteer-pipeline/defaults"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { expect, test } from "vitest"

test("the canonical coverage recipe holds its reconstructed shape (see #1015/#1021)", () => {
	// The counts are a deliberate-drift guard. Update them with the recipe, never to make a
	// failing test pass.
	expect(DEFAULT_WOF_PRIORITY_COUNTRIES).toHaveLength(12)
	expect(DEFAULT_OVERTURE_COUNTRIES).toHaveLength(85)
	expect(DEFAULT_GEONAMES_COUNTRIES).toHaveLength(161)

	// A country served by both sources would double up its admin.
	for (const cc of DEFAULT_WOF_PRIORITY_COUNTRIES) {
		expect(DEFAULT_OVERTURE_COUNTRIES).not.toContain(cc)
	}

	for (const list of [DEFAULT_WOF_PRIORITY_COUNTRIES, DEFAULT_OVERTURE_COUNTRIES, DEFAULT_GEONAMES_COUNTRIES]) {
		expect(new Set(list).size).toBe(list.length)

		for (const cc of list) {
			expect(cc).toMatch(/^[A-Z]{2}$/)
		}
	}

	expect(DEFAULT_OVERTURE_COUNTRIES).toContain("BE")
	expect(DEFAULT_GEONAMES_COUNTRIES).toContain("GE")
})

test("geonamesAdminGapCountries is the zero-coverage gap set (#1026 — the GeoNames admin fold targets)", () => {
	const gap = geonamesAdminGapCountries()

	// GeoNames-only locales: in the alias set, but carrying no WOF or Overture admin.
	expect(gap).toHaveLength(147)

	for (const cc of gap) {
		expect(DEFAULT_GEONAMES_COUNTRIES).toContain(cc)
		expect(DEFAULT_OVERTURE_COUNTRIES).not.toContain(cc)
		expect(DEFAULT_WOF_PRIORITY_COUNTRIES).not.toContain(cc)
	}

	// The trigger and a sample of the flattened set must be covered.
	for (const cc of ["GE", "AD", "HT", "SO", "XK", "VA"]) {
		expect(gap).toContain(cc)
	}

	// Overture-covered locales stay out, since their admin would double up.
	for (const cc of ["BE", "AT", "CH", "LU"]) {
		expect(gap).not.toContain(cc)
	}
})
