/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { streetNameForms } from "#tools/street-names"

describe("streetNameForms", () => {
	it("answers to each language form of a bilingual name and to the joined value", () => {
		expect(streetNameForms("Heol y Wig / Pier Street")).toEqual([
			"Heol y Wig / Pier Street",
			"Heol y Wig",
			"Pier Street",
		])
	})

	it("leaves a single-language name as it is", () => {
		expect(streetNameForms("High Street")).toEqual(["High Street"])
	})

	it("keeps a slash without surrounding spaces inside one name", () => {
		expect(streetNameForms("A1/B2 Link Road")).toEqual(["A1/B2 Link Road"])
	})

	it("drops an empty form left by a trailing separator", () => {
		expect(streetNameForms("Dan Dre / ")).toEqual(["Dan Dre / ", "Dan Dre"])
	})
})
