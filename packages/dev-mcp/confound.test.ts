/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { assertComparableField, VariableIsolation, checkConfounds } from "./confound.ts"

describe("checkConfounds", () => {
	it("reports clean isolation when exactly the declared key moved", () => {
		const reading = checkConfounds(
			{ locale: "en-US", gazetteerPrior: false },
			{ locale: "en-US", gazetteerPrior: true },
			["gazetteerPrior"]
		)

		expect(reading.variable_isolation).toBe(VariableIsolation.Clean)
		expect(reading.variable_effective).toEqual(["gazetteerPrior"])
		expect(reading.warnings).toHaveLength(0)
	})

	it("catches the documented backend/country-scope confound", () => {
		// resolver-backends.mdx: under --country-scope auto, switching backend ALSO switches country scoping, and its
		// own table shows the same Paris address landing in Texas or France depending which variable actually moved.
		const reading = checkConfounds(
			{ backend: "fts", countryScope: "locale" },
			{ backend: "candidate", countryScope: "none" },
			["backend"]
		)

		expect(reading.variable_isolation).toBe(VariableIsolation.Ambiguous)
		expect(reading.moved_but_undeclared).toEqual(["countryScope"])
		expect(reading.warnings[0]).toContain("countryScope")
	})

	it("warns rather than refusing, so the comparison still returns", () => {
		// The decided behaviour (spec §6.3). A refusal an agent cannot override is a reason to bypass the tool.
		expect(() => checkConfounds({ a: 1 }, { a: 2, b: 3 }, ["a"])).not.toThrow()
	})

	it("flags a declared key that did not actually move", () => {
		const reading = checkConfounds({ locale: "en-US" }, { locale: "en-US" }, ["locale"])

		expect(reading.declared_but_unmoved).toEqual(["locale"])
	})

	it("names identical arms as such rather than calling it clean", () => {
		const reading = checkConfounds({ locale: "en-US" }, { locale: "en-US" }, ["locale"])

		expect(reading.variable_isolation).toBe(VariableIsolation.NoVariable)
		expect(reading.warnings.join(" ")).toContain("identical effective configurations")
	})

	it("compares by value, so an unchanged nested object is not a difference", () => {
		const reading = checkConfounds({ opts: { x: 1 } }, { opts: { x: 1 } }, [])

		expect(reading.variable_effective).toHaveLength(0)
	})
})

describe("assertComparableField", () => {
	it("refuses the cross-backend score fields", () => {
		// Refusal, not a warning: within EITHER backend the wrong answers' range sits inside the correct answers' range
		// with a higher mean, so no threshold on it means anything.
		expect(() => assertComparableField("resolver_score")).toThrow(/not comparable/)
		expect(() => assertComparableField("prominence")).toThrow(/not comparable/)
	})

	it("allows an ordinary field", () => {
		expect(() => assertComparableField("lat")).not.toThrow()
	})
})

describe("the declared vocabulary", () => {
	it("grades a correctly-declared single lever CLEAN, not ambiguous", () => {
		// The defect this closes, found 2026-08-16 by running a real A/B: `variable: ["place_country"]` is the spelling
		// the tool schema documents, and the effective configs differ at `placeCountry`. Compared raw, the same lever was
		// counted twice under two spellings — once as declared-but-unmoved, once as moved-but-undeclared — so every
		// honest single-lever comparison reported ATTRIBUTION AMBIGUOUS.
		const reading = checkConfounds({ placeCountry: true }, { placeCountry: false }, ["place_country"])

		expect(reading.variable_isolation).toBe("clean")
		expect(reading.moved_but_undeclared).toEqual([])
		expect(reading.declared_but_unmoved).toEqual([])
	})

	it("still reports the caller's own spelling back to them", () => {
		// Filtered on the translated key, reported in the spelling they typed — naming a key they never wrote is its own
		// small confusion.
		const reading = checkConfounds({ placeCountry: true }, { placeCountry: true }, ["place_country"])

		expect(reading.declared_but_unmoved).toEqual(["place_country"])
	})

	it("still catches a genuine undeclared difference", () => {
		const reading = checkConfounds(
			{ placeCountry: true, countryScope: "auto" },
			{ placeCountry: false, countryScope: "none" },
			["place_country"]
		)

		expect(reading.variable_isolation).toBe("ambiguous")
		expect(reading.moved_but_undeclared).toEqual(["countryScope"])
	})
})
