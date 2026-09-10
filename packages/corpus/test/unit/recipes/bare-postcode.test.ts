/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `bare-postcode` — the postcode standing alone. The contract worth pinning is that every surface the recipe
 *   renders is one `known-formats.ts` reads as a postcode over its whole span, because a surface the detector refuses
 *   would train the model on a string the query-shape prior cannot then support. `run` reads a 500 MB archive; this
 *   reaches the rendering and the agreement without it.
 */

import { detectedAsPostcode, renderBarePostcode } from "@mailwoman/corpus/recipes/bare-postcode"
import { describe, expect, it } from "vitest"

describe("renderBarePostcode", () => {
	it("writes the NNN NN countries with the space, and keeps the compact form too", () => {
		expect(renderBarePostcode("CZ", "11900")).toEqual(["119 00", "11900"])
		expect(renderBarePostcode("SK", "81101")).toEqual(["811 01", "81101"])
		expect(renderBarePostcode("SE", "16268")).toEqual(["162 68", "16268"])
	})

	it("accepts a code the source already spaced", () => {
		// OpenAddresses stores Swedish codes spaced ("162 68") and Czech ones compact ("11900"); the
		// rendering must not depend on which spelling the publisher chose.
		expect(renderBarePostcode("SE", "162 68")).toEqual(["162 68", "16268"])
	})

	it("writes the Dutch letters form both ways", () => {
		expect(renderBarePostcode("NL", "1012LG")).toEqual(["1012 LG", "1012LG"])
		expect(renderBarePostcode("NL", "1012 lg")).toEqual(["1012 LG", "1012LG"])
	})

	it("renders nothing for a country whose bare postcode was never in doubt", () => {
		// GB opens with letters, which no model read as a house number, so it is deliberately absent from
		// the written-form table.
		expect(renderBarePostcode("GB", "SW1A 1AA")).toEqual([])
	})

	it("keeps Greece's written form even though no source carries Greek postcodes", () => {
		// Two separate facts, and collapsing them would lose one. The SHAPE is known — `gr_postcode` is
		// `NNN NN`, same as its three neighbours — so the rendering answers. The DATA is absent: the
		// archive's only Greek member declares a postcode column holding nothing across 10,877 rows, so
		// `SOURCES` names no Greek file and the slice emits no row claiming to be Greek.
		expect(renderBarePostcode("GR", "55131")).toEqual(["551 31", "55131"])
	})

	it("renders nothing for a code that does not fit the country's shape", () => {
		expect(renderBarePostcode("CZ", "1190")).toEqual([])
		expect(renderBarePostcode("NL", "1012")).toEqual([])
	})
})

describe("the rendering agrees with known-formats", () => {
	// One code per carried country, in the publisher's own spelling.
	const SAMPLES: Array<[string, string]> = [
		["CZ", "11900"],
		["CZ", "60200"],
		["SK", "81101"],
		["SE", "162 68"],
		["SE", "11120"],
		["NL", "1012LG"],
		["NL", "5801CR"],
	]

	for (const [country, postcode] of SAMPLES) {
		it(`every surface for ${country} ${postcode} is read as a postcode`, () => {
			const surfaces = renderBarePostcode(country, postcode)

			expect(surfaces.length).toBeGreaterThan(0)

			for (const surface of surfaces) {
				expect(detectedAsPostcode(surface), `${surface} is not read as a postcode`).toBe(true)
			}
		})
	}

	it("refuses a surface the detector reads as something else", () => {
		// The guard's own polarity: a four-digit group alone is not a postcode shape any pattern claims
		// over its whole span, so the recipe would refuse it rather than emit it.
		expect(detectedAsPostcode("1012")).toBe(false)
		expect(detectedAsPostcode("119 000")).toBe(false)
	})
})
