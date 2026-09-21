/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The postal-regime table's own shape, and the reading it exists to make legible: every regime it names is unmodeled
 *   or partial today.
 *
 *   That last assertion is the one worth keeping. When a regime starts being modeled, this test fails and whoever
 *   modeled it writes down which layout, lexicon, postcode shape or check now distinguishes it. A table nobody
 *   maintains reports the coverage of the day it was written.
 */

import {
	POSTAL_REGIMES,
	postalRegimeByID,
	postalRegimesForCountry,
	RegimeCoverage,
	RegimeKind,
} from "@mailwoman/codex/postal-regimes"
import { describe, expect, it } from "vitest"

describe("POSTAL_REGIMES", () => {
	it("names the seven families the corpus specification lists", () => {
		expect(POSTAL_REGIMES).toHaveLength(7)
	})

	it("gives every regime a unique id that is not an ISO code", () => {
		const ids = POSTAL_REGIMES.map((regime) => regime.regimeID)

		expect(new Set(ids).size).toBe(ids.length)

		for (const id of ids) {
			// A two-letter id would read as a country wherever a regime and a country meet.
			expect(id.length).toBeGreaterThan(2)
			expect(id).toMatch(/^[a-z][a-z0-9-]*$/u)
		}
	})

	it("gives every regime at least one ISO code, a declared kind and a coverage", () => {
		for (const regime of POSTAL_REGIMES) {
			expect(regime.iso2.length, regime.regimeID).toBeGreaterThan(0)

			for (const code of regime.iso2) {
				expect(code, regime.regimeID).toMatch(/^[A-Z]{2}$/u)
			}

			expect(Object.values(RegimeKind)).toContain(regime.kind)
			expect(Object.values(RegimeCoverage)).toContain(regime.coverage)
		}
	})

	it("gives every regime a shape and a note, because a bare state invites the reader to invent one", () => {
		for (const regime of POSTAL_REGIMES) {
			expect(regime.shape.length, regime.regimeID).toBeGreaterThan(40)
			expect(regime.note.length, regime.regimeID).toBeGreaterThan(40)
		}
	})

	it("reports that nothing distinguishes any of them from its parent country yet", () => {
		// The measurement this table records. `XK` is `partial` because the source register
		// counts it as a jurisdiction while no layout, postcode shape or lexicon names it.
		const modeled = POSTAL_REGIMES.filter((regime) => regime.coverage === RegimeCoverage.Modeled)

		expect(modeled.map((regime) => regime.regimeID)).toEqual([])
	})
})

describe("postalRegimesForCountry", () => {
	it("finds the regimes an ISO code carries, case-insensitively", () => {
		expect(postalRegimesForCountry("us").map((regime) => regime.regimeID)).toEqual(["us-military-mail"])
		expect(postalRegimesForCountry("GB").map((regime) => regime.regimeID)).toEqual(["uk-forces-post-office"])
	})

	it("finds a cross-border regime under each country it touches", () => {
		for (const code of ["VA", "SM", "MC", "LI", "IT", "CH"]) {
			expect(
				postalRegimesForCountry(code).map((regime) => regime.regimeID),
				code
			).toContain("european-microstate-postal-unions")
		}
	})

	it("answers an empty array for a country no regime names, which is not a claim that its addresses are ordinary", () => {
		expect(postalRegimesForCountry("FR")).toEqual([])
		expect(postalRegimesForCountry("JP")).toEqual([])
	})
})

describe("postalRegimeByID", () => {
	it("finds a regime and answers undefined for an unknown id", () => {
		expect(postalRegimeByID("us-military-mail")?.kind).toBe(RegimeKind.Routing)
		expect(postalRegimeByID("no-such-regime")).toBeUndefined()
	})
})
