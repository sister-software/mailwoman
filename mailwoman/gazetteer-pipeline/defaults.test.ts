/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { expect, test } from "vitest"

import {
	DEFAULT_GEONAMES_COUNTRIES,
	DEFAULT_OVERTURE_COUNTRIES,
	DEFAULT_WOF_PRIORITY_COUNTRIES,
	geonamesAdminGapCountries,
} from "./defaults.ts"

test("the canonical coverage recipe holds its reconstructed shape (see #1015/#1021)", () => {
	expect(DEFAULT_WOF_PRIORITY_COUNTRIES).toHaveLength(11)
	expect(DEFAULT_OVERTURE_COUNTRIES).toHaveLength(86)
	expect(DEFAULT_GEONAMES_COUNTRIES).toHaveLength(161)

	// No duplicates; all ISO-2 uppercase.
	for (const list of [DEFAULT_WOF_PRIORITY_COUNTRIES, DEFAULT_OVERTURE_COUNTRIES, DEFAULT_GEONAMES_COUNTRIES]) {
		expect(new Set(list).size).toBe(list.length)

		for (const cc of list) {
			expect(cc).toMatch(/^[A-Z]{2}$/)
		}
	}
	expect(DEFAULT_OVERTURE_COUNTRIES).toContain("BE") // the #1015 case
	expect(DEFAULT_GEONAMES_COUNTRIES).toContain("GE") // the #1023/#1026 case
})

test("geonamesAdminGapCountries is the zero-coverage gap set (#1026 — the GeoNames admin fold targets)", () => {
	const gap = geonamesAdminGapCountries()

	// GeoNames-only locales: in the alias set, but carrying NO WOF or Overture admin.
	expect(gap).toHaveLength(147)

	for (const cc of gap) {
		expect(DEFAULT_GEONAMES_COUNTRIES).toContain(cc)
		expect(DEFAULT_OVERTURE_COUNTRIES).not.toContain(cc)
		expect(DEFAULT_WOF_PRIORITY_COUNTRIES).not.toContain(cc)
	}

	// The #1023/#1026 trigger and a sample of the flattened set MUST be covered…
	for (const cc of ["GE", "AD", "HT", "SO", "XK", "VA"]) {
		expect(gap).toContain(cc)
	}

	// …while Overture-covered locales stay out (their admin would double up — the #267 warning).
	for (const cc of ["BE", "AT", "CH", "LU"]) {
		expect(gap).not.toContain(cc)
	}
})
