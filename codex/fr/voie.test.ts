/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { isFrenchStreetWord } from "./voie.js"

describe("isFrenchStreetWord", () => {
	it("matches canonical voie words, case- and accent-insensitive", () => {
		expect(isFrenchStreetWord("Rue")).toBe(true)
		expect(isFrenchStreetWord("avenue")).toBe(true)
		expect(isFrenchStreetWord("Boulevard")).toBe(true)
		expect(isFrenchStreetWord("Allée")).toBe(true)
		expect(isFrenchStreetWord("allee")).toBe(true) // unaccented
		expect(isFrenchStreetWord("Impasse")).toBe(true)
	})

	it("matches common abbreviations", () => {
		expect(isFrenchStreetWord("bd")).toBe(true)
		expect(isFrenchStreetWord("av")).toBe(true)
		expect(isFrenchStreetWord("pl")).toBe(true)
		expect(isFrenchStreetWord("rte")).toBe(true)
	})

	it("matches the whole token, so a non-voie word is not caught", () => {
		// French types LEAD the name and are matched as whole tokens, not suffixes — so neither a
		// surname nor a commune that happens to contain a voie substring is flagged.
		expect(isFrenchStreetWord("Paris")).toBe(false)
		expect(isFrenchStreetWord("Bordeaux")).toBe(false)
		expect(isFrenchStreetWord("Larue")).toBe(false) // contains "rue" but isn't it
	})

	it("rejects non-strings", () => {
		expect(isFrenchStreetWord(42)).toBe(false)
		expect(isFrenchStreetWord(null)).toBe(false)
	})
})
