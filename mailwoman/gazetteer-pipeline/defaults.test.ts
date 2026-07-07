/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { expect, test } from "vitest"

import { DEFAULT_GEONAMES_COUNTRIES, DEFAULT_OVERTURE_COUNTRIES, DEFAULT_WOF_PRIORITY_COUNTRIES } from "./defaults.js"

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
