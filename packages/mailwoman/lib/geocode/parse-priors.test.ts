/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { NUMBERED_MORPHOLOGY_OPTS, ZEROED_MORPHOLOGY_OPTS, type FSTMatcherLike } from "@mailwoman/core/pipeline"
import { describe, expect, it } from "vitest"

import { loadParsePriors, parsePriorOptions } from "#geocode/parse-priors"

const MATCHER: FSTMatcherLike = {
	walk: () => null,
	walkFrom: () => null,
	accepting: () => [],
}

describe("loadParsePriors", () => {
	it("returns no FST matchers for a classifier that exposes no FST artifact, and says so once", async () => {
		const warnings: string[] = []
		const priors = await loadParsePriors({}, { label: "the stub", onWarn: (message) => warnings.push(message) })

		expect(priors.fst).toBeNull()
		expect(priors.streetMorphology).toBeNull()
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("the stub")
	})

	it("loads the street-morphology matcher beside an FST the caller already holds", async () => {
		const priors = await loadParsePriors({}, { fst: MATCHER, onWarn: () => {} })

		expect(priors.fst).toBe(MATCHER)
		expect(priors.streetMorphology).not.toBeNull()
		expect(priors.streetMorphology!.walk(["street"])).not.toBeNull()
	})

	it("loads nothing when the gazetteer prior is off", async () => {
		const warnings: string[] = []
		const priors = await loadParsePriors({}, { gazetteerPrior: false, onWarn: (message) => warnings.push(message) })

		expect(priors.fst).toBeNull()
		expect(priors.streetMorphology).toBeNull()
		expect(warnings).toEqual([])
	})

	it("returns the venue-head lexicon of a country, memoized, and none when the prior is off", async () => {
		const priors = await loadParsePriors({}, { gazetteerPrior: false })
		const gb = priors.venueHeadFor("gb")

		expect(gb).not.toBeNull()
		expect(gb!.last("gallery")).toBeTypeOf("number")
		expect(priors.venueHeadFor("GB")).toBe(gb)

		const off = await loadParsePriors({}, { gazetteerPrior: false, venueHeadPrior: false })

		expect(off.venueHeadFor("GB")).toBeNull()
	})
})

describe("venueHeadOptsFor", () => {
	it("reads the country's street-type abbreviations beside the matcher, and the codex country names", async () => {
		const priors = await loadParsePriors({}, { fst: MATCHER, onWarn: () => {} })
		const us = priors.venueHeadOptsFor("US")

		expect(us.isStreetAffix!("st")).toBe(true)
		expect(us.isStreetAffix!("nw")).toBe(true)
		expect(us.isStreetAffix!("street")).toBe(true)
		expect(us.isStreetAffix!("school")).toBe(false)
		expect(us.isCountryName!("united states of america")).toBe(true)
		expect(us.isCountryName!("of america")).toBe(false)
		expect(priors.venueHeadOptsFor("us")).toBe(us)

		// A country without a codex table reads the matcher's own street types.
		// Those hold `st` and `street` and no directional.
		const jamaica = priors.venueHeadOptsFor("JM")

		expect(jamaica.isStreetAffix!("st")).toBe(true)
		expect(jamaica.isStreetAffix!("street")).toBe(true)
		expect(jamaica.isStreetAffix!("nw")).toBe(false)
	})
})

describe("parsePriorOptions", () => {
	it("passes the numbered-segment weights with the prior on and the zeroed weights with it off", () => {
		const priors = { fst: MATCHER, streetMorphology: MATCHER }

		expect(parsePriorOptions(priors, { streetMorphologyPrior: true }).fstStreetMorphologyOpts).toEqual(
			NUMBERED_MORPHOLOGY_OPTS
		)

		expect(parsePriorOptions(priors, {}).fstStreetMorphologyOpts).toEqual(ZEROED_MORPHOLOGY_OPTS)
		expect(parsePriorOptions(priors, {}).fst).toBe(MATCHER)
	})

	it("passes no street-context options without both matchers and no venue-head options without a lexicon", () => {
		const options = parsePriorOptions({ fst: null, streetMorphology: MATCHER }, { venueHeadOpts: { biasScale: 1 } })

		expect(options).toEqual({})
	})

	it("passes the venue-head lexicon with its overrides", () => {
		const lexicon = { first: () => null, last: () => null, suffix: () => null }

		const options = parsePriorOptions(
			{ fst: null, streetMorphology: null },
			{ venueHead: lexicon, venueHeadOpts: { biasScale: 1 } }
		)

		expect(options.venueHead).toBe(lexicon)
		expect(options.venueHeadOpts).toEqual({ biasScale: 1 })
	})
})
