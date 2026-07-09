/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { parsePersonName } from "./name.ts"

describe("parsePersonName", () => {
	it("returns null for empty input", () => {
		expect(parsePersonName("")).toBeNull()
		expect(parsePersonName(null)).toBeNull()
		expect(parsePersonName("   ")).toBeNull()
	})

	it("parses a simple given + family name", () => {
		expect(parsePersonName("John Smith")).toEqual({ given: "John", family: "Smith" })
	})

	it("treats a lone token as a given name", () => {
		expect(parsePersonName("Madonna")).toEqual({ given: "Madonna" })
	})

	it("assigns the inner token(s) to the middle name", () => {
		expect(parsePersonName("Mary Ann Smith")).toEqual({ given: "Mary", middle: "Ann", family: "Smith" })
	})

	it("inverts 'Last, First'", () => {
		expect(parsePersonName("Smith, John")).toEqual({ given: "John", family: "Smith" })
	})

	it("keeps order when the comma tail is a suffix", () => {
		expect(parsePersonName("John Smith, Jr.")).toEqual({ given: "John", family: "Smith", suffix: "Jr." })
	})

	it("extracts a quoted nickname and a leading title", () => {
		expect(parsePersonName('Mr George "Gob" Bluth II')).toEqual({
			prefix: "Mr",
			given: "George",
			nickname: "Gob",
			family: "Bluth",
			suffix: "II",
		})
	})

	it("extracts a parenthetical nickname", () => {
		expect(parsePersonName("James (Jim) Gordon")).toEqual({ given: "James", nickname: "Jim", family: "Gordon" })
	})

	it("stores the surname particle separately (de la Vega)", () => {
		expect(parsePersonName("Dr. Juan Q. Xavier de la Vega III")).toEqual({
			prefix: "Dr.",
			given: "Juan",
			middle: "Q. Xavier",
			familyParticle: "de la",
			family: "Vega",
			suffix: "III",
		})
	})

	it("handles a multi-token particle after inversion (van der Berg)", () => {
		expect(parsePersonName("van der Berg, Johan")).toEqual({
			given: "Johan",
			familyParticle: "van der",
			family: "Berg",
		})
	})

	it("does not treat a trailing particle-looking token as a particle", () => {
		// "Di" with nothing after it is a surname, not a particle.
		expect(parsePersonName("Robert Di")).toEqual({ given: "Robert", family: "Di" })
	})
})
