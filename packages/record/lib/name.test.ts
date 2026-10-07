/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { formatPersonName, type PersonName, parsePersonName } from "#name"

function nameOf(parts: Partial<PersonName>): PersonName {
	return {
		prefix: null,
		given: null,
		middle: null,
		family: null,
		familyParticle: null,
		suffix: null,
		nickname: null,
		...parts,
	}
}

describe("parsePersonName", () => {
	it("returns null for empty input", () => {
		expect(parsePersonName("")).toBeNull()
		expect(parsePersonName(null)).toBeNull()
		expect(parsePersonName("   ")).toBeNull()
	})

	it("parses a simple given + family name", () => {
		expect(parsePersonName("John Smith")).toEqual(nameOf({ given: "John", family: "Smith" }))
	})

	it("treats a lone token as a given name", () => {
		expect(parsePersonName("Madonna")).toEqual(nameOf({ given: "Madonna" }))
	})

	it("assigns the inner token(s) to the middle name", () => {
		expect(parsePersonName("Mary Ann Smith")).toEqual(nameOf({ given: "Mary", middle: "Ann", family: "Smith" }))
	})

	it("inverts 'Last, First'", () => {
		expect(parsePersonName("Smith, John")).toEqual(nameOf({ given: "John", family: "Smith" }))
	})

	it("keeps order when the comma tail is a suffix", () => {
		expect(parsePersonName("John Smith, Jr.")).toEqual(nameOf({ given: "John", family: "Smith", suffix: "Jr." }))
	})

	it("extracts a quoted nickname and a leading title", () => {
		expect(parsePersonName('Mr George "Gob" Bluth II')).toEqual(
			nameOf({
				prefix: "Mr",
				given: "George",
				nickname: "Gob",
				family: "Bluth",
				suffix: "II",
			})
		)
	})

	it("extracts a parenthetical nickname", () => {
		expect(parsePersonName("James (Jim) Gordon")).toEqual(nameOf({ given: "James", nickname: "Jim", family: "Gordon" }))
	})

	it("stores the surname particle separately (de la Vega)", () => {
		expect(parsePersonName("Dr. Juan Q. Xavier de la Vega III")).toEqual(
			nameOf({
				prefix: "Dr.",
				given: "Juan",
				middle: "Q. Xavier",
				familyParticle: "de la",
				family: "Vega",
				suffix: "III",
			})
		)
	})

	it("handles a multi-token particle after inversion (van der Berg)", () => {
		expect(parsePersonName("van der Berg, Johan")).toEqual(
			nameOf({
				given: "Johan",
				familyParticle: "van der",
				family: "Berg",
			})
		)
	})

	it("does not treat a trailing particle-looking token as a particle", () => {
		expect(parsePersonName("Robert Di")).toEqual(nameOf({ given: "Robert", family: "Di" }))
	})
})

describe("formatPersonName", () => {
	it("round-trips a name the parser did not have to reorder", () => {
		for (const input of ["Robert Di", "Johan van der Berg", "Dr Jane Q. Xavier de la Vega III"]) {
			expect(formatPersonName(parsePersonName(input))).toBe(input)
		}
	})

	it("prints an inverted name in reading order", () => {
		expect(formatPersonName(parsePersonName("van der Berg, Johan"))).toBe("Johan van der Berg")
	})

	it("keeps the particle with the surname in both styles", () => {
		const name = parsePersonName("Dr Jane Q. Xavier de la Vega III")

		// The parser stores the particle separately for the matcher, so printing it
		// apart would produce a form absent from the input name.
		expect(formatPersonName(name, "short")).toBe("Jane de la Vega")
	})

	it("omits the nickname, which is an alternative to the given name rather than an addition", () => {
		expect(formatPersonName(parsePersonName(`George "Gob" Bluth`))).toBe("George Bluth")
	})

	it("answers an empty string for nothing to print", () => {
		expect(formatPersonName(null)).toBe("")
		expect(formatPersonName({})).toBe("")
		expect(formatPersonName({ given: "   " })).toBe("")
	})
})
