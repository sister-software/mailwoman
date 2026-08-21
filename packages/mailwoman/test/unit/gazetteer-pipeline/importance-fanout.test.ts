/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture-scale cover for the Wikidata concordance fan-out guard (#1497).
 *
 *   The four named fixtures are the real groups the 2026-08-05 survey pulled out of
 *   `admin-global-priority.db`, coordinates and populations included — one per branch of the rule, so
 *   a change to the rule that breaks a real case breaks a test rather than a rebuild.
 */

import { FANOUT_SPREAD_EPSILON_KM, resolveConcordanceFanout } from "mailwoman/gazetteer-pipeline/importance-fanout"
import { describe, expect, it } from "vitest"

/**
 * Q61 — Washington DC as WOF models it: one place carrying three placetypes at one point. NOT an error, and the reason
 * the guard cannot simply drop every fanned-out id.
 */
const Q61 = [
	{ id: 85_688_741, placetype: "region", lat: 38.9047, lon: -77.0163, population: 678_972 },
	{ id: 85_931_779, placetype: "locality", lat: 38.9047, lon: -77.0163, population: 678_972 },
	{ id: 1_377_370_667, placetype: "county", lat: 38.9047, lon: -77.0163, population: 678_972 },
]

/**
 * Q18125 — Manchester, England, also attached to two American villages. Population is decisive.
 */
const Q18125 = [
	{ id: 101_717_233, placetype: "locality", lat: 40.0614, lon: -76.7191, population: 2788 },
	{ id: 85_969_021, placetype: "locality", lat: 43.7253, lon: -93.4513, population: 53 },
	{ id: 101_750_525, placetype: "locality", lat: 53.4622, lon: -2.2295, population: 547_627 },
]

/**
 * Q1794 — Frankfurt am Main, attached to both the city and a neighbourhood 12 km out. Beyond the coincidence radius, so
 * population decides; the city wins, which is also what stops the two from carrying IDENTICAL importance and blurring
 * the placetype signal.
 */
const Q1794 = [
	{ id: 101_913_837, placetype: "locality", lat: 50.1155, lon: 8.6842, population: 763_380 },
	{ id: 85_796_795, placetype: "neighbourhood", lat: 50.0333, lon: 8.5333, population: 650_000 },
]

/**
 * Q340 — Montréal, CANADA, attached to two French communes 182 km apart, neither with a population row. No evidence to
 * pick between them and both are wrong, so the id is dropped whole.
 */
const Q340 = [
	{ id: 102_068_207, placetype: "county", lat: 43.9361, lon: 0.1972, population: 0 },
	{ id: 102_068_331, placetype: "county", lat: 43.1839, lon: 2.2022, population: 0 },
]

describe("resolveConcordanceFanout", () => {
	it("passes a singleton through untouched", () => {
		const only = [{ id: 7, placetype: "locality", lat: 1, lon: 2, population: 500 }]

		expect(resolveConcordanceFanout(only)).toEqual({ verdict: "single", keep: [7] })
	})

	it("keeps EVERY member of a coincident group — the dual-role case", () => {
		const result = resolveConcordanceFanout(Q61)

		expect(result.verdict).toBe("coincident")

		expect(result.keep.toSorted((a, b) => a - b)).toEqual(
			[85_688_741, 85_931_779, 1_377_370_667].toSorted((a, b) => a - b)
		)
	})

	it("keeps the most populous when the group is spread out", () => {
		// 6,327 km apart: Manchester GB beats Manchester PA and Manchester MN.
		expect(resolveConcordanceFanout(Q18125)).toEqual({ verdict: "population", keep: [101_750_525] })
	})

	it("prefers the city over its own neighbourhood just past the coincidence radius", () => {
		expect(resolveConcordanceFanout(Q1794)).toEqual({ verdict: "population", keep: [101_913_837] })
	})

	it("DROPS the whole id when distant candidates carry no population signal", () => {
		expect(resolveConcordanceFanout(Q340)).toEqual({ verdict: "unresolvable", keep: [] })
	})

	it("drops on a population TIE between distant candidates", () => {
		// A tie is not evidence. Picking the first would be picking by row order.
		const tied = [
			{ id: 1, placetype: "locality", lat: 0, lon: 0, population: 1000 },
			{ id: 2, placetype: "locality", lat: 10, lon: 10, population: 1000 },
		]

		expect(resolveConcordanceFanout(tied)).toEqual({ verdict: "unresolvable", keep: [] })
	})

	it("treats a zero-population maximum as no signal, not as a winner", () => {
		// The meaning-of-zero rule: absent population is stored as 0, so "the biggest of several
		// zeroes" must not read as a decisive maximum.
		const zeroes = [
			{ id: 1, placetype: "locality", lat: 0, lon: 0, population: 0 },
			{ id: 2, placetype: "locality", lat: 10, lon: 10, population: 0 },
		]

		expect(resolveConcordanceFanout(zeroes)).toEqual({ verdict: "unresolvable", keep: [] })
	})

	it("uses coincidence BEFORE population, so a dual-role group survives a population gap", () => {
		// Same point, different populations (WOF does not always populate every role's row). The
		// coincidence branch must win — otherwise the region/county rows of a real city get dropped.
		const rolesWithGap = [
			{ id: 1, placetype: "region", lat: 50, lon: 8, population: 0 },
			{ id: 2, placetype: "locality", lat: 50, lon: 8, population: 763_380 },
		]

		const result = resolveConcordanceFanout(rolesWithGap)

		expect(result.verdict).toBe("coincident")
		expect(result.keep).toHaveLength(2)
	})

	it("measures spread across the WHOLE group, not just the first pair", () => {
		// First two are coincident; the third is 6,000 km away. A pairwise-first implementation would
		// call this coincident and keep the outlier.
		const straggler = [
			{ id: 1, placetype: "locality", lat: 50, lon: 8, population: 100 },
			{ id: 2, placetype: "locality", lat: 50, lon: 8, population: 900 },
			{ id: 3, placetype: "locality", lat: 40, lon: -74, population: 500 },
		]

		expect(resolveConcordanceFanout(straggler)).toEqual({ verdict: "population", keep: [2] })
	})

	it("exposes a coincidence radius small enough to stay inside one settlement", () => {
		expect(FANOUT_SPREAD_EPSILON_KM).toBeGreaterThan(0)
		expect(FANOUT_SPREAD_EPSILON_KM).toBeLessThanOrEqual(10)
	})
})
