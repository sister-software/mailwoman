/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   An identity law must report `diverges` for two different places 90 meters apart.
 *   A comparator with its axis absent on both sides must report `undecidable`, not `equivalent`.
 */

import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { compareResults, type ConformanceResult } from "#tools/eval-harness/conformance/comparators"
import type { ConformanceFixture } from "#tools/eval-harness/conformance/fixture"
import type { GauntletResult } from "#tools/eval-harness/gauntlet/harness"

function result(over: Partial<GauntletResult> = {}): GauntletResult {
	return {
		components: {},
		lat: null,
		lon: null,
		tier: "admin",
		locality: null,
		region: null,
		country: null,
		postcode: null,
		house_number: null,
		street: null,
		venue: null,
		dependent_locality: null,
		unit: null,
		postcode_country_scope: null,
		capital_promotion: null,
		variant_alias_exemption: "not_applied",
		admin_coherence: null,
		hierarchy: [],
		...over,
	}
}

function observed(over: Partial<GauntletResult> = {}, mechanismShapes?: readonly string[]): ConformanceResult {
	return mechanismShapes ? { result: result(over), mechanismShapes } : { result: result(over) }
}

function fixture(over: Partial<ConformanceFixture> = {}): ConformanceFixture {
	return {
		id: "cnf-sample-01",
		law: "case-folding-invariance",
		base: "10 Downing Street, London",
		variant: "10 DOWNING STREET, LONDON",
		resultComparator: "resolution_identity",
		expect: "equivalent",
		context: null,
		status: null,
		bugRef: null,
		rowRef: null,
		toleranceM: null,
		note: null,
		...over,
	}
}

/**
 * Only a hand-built fixture that skips the loader can reach a comparator with an unknown name.
 * This test exercises that path.
 */
function comparatorName(value: string): ConformanceFixture["resultComparator"] {
	return value as ConformanceFixture["resultComparator"]
}

const IDENTITY = fixture()
const COORDINATE = fixture({ resultComparator: "assembled_coordinate" })
const STRICT = fixture({ resultComparator: "parse_whole_strict" })
const COMPONENTS = fixture({ resultComparator: "component_map" })
const MECHANISM = fixture({ resultComparator: "mechanism_shape" })

const LONDON = [
	{ tag: "locality", name: "London", placeID: "wof:101750367", lat: null, lon: null },
	{ tag: "country", name: "United Kingdom", placeID: "wof:85633159", lat: null, lon: null },
]

describe("resolution_identity", () => {
	it("reads the same chain as equivalent", () => {
		const reading = compareResults(IDENTITY, observed({ hierarchy: LONDON }), observed({ hierarchy: LONDON }))

		expect(reading.observed).toBe("equivalent")
		expect(reading.differences).toEqual([])
	})

	it("diverges on two different places 90 meters apart — a coordinate is never read", () => {
		const near = [
			{ tag: "locality", name: "London", placeID: "wof:404227469", lat: 51.5015, lon: -0.1246 },
			{ tag: "country", name: "United Kingdom", placeID: "wof:85633159", lat: null, lon: null },
		]

		const reading = compareResults(
			IDENTITY,
			observed({ hierarchy: LONDON, lat: 51.5007, lon: -0.1246 }),
			observed({ hierarchy: near, lat: 51.5015, lon: -0.1246 })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.basis).toContain("coordinates not read")
	})

	it("reads a chain extended at the fine end as a refinement", () => {
		const deeper = [
			{ tag: "dependent_locality", name: "Westminster", placeID: "wof:85681877", lat: null, lon: null },
			...LONDON,
		]

		const reading = compareResults(IDENTITY, observed({ hierarchy: LONDON }), observed({ hierarchy: deeper }))

		expect(reading.observed).toBe("refines")
		expect(reading.differences[0]).toContain("dependent_locality:wof:85681877")
	})

	it("reports undecidable when neither side carries a place identity", () => {
		const nameOnly = [{ tag: "locality", name: "London", placeID: null, lat: null, lon: null }]
		const reading = compareResults(IDENTITY, observed({ hierarchy: nameOnly }), observed({ hierarchy: nameOnly }))

		expect(reading.observed).toBe("undecidable")
		expect(reading.basis).toContain("1 unverifiable")
	})
})

describe("assembled_coordinate", () => {
	it("holds inside the fixture's own tolerance at an unchanged tier", () => {
		const reading = compareResults(
			fixture({ resultComparator: "assembled_coordinate", toleranceM: 250 }),
			observed({ lat: 51.5034, lon: -0.1276, tier: "address_point" }),
			observed({ lat: 51.5035, lon: -0.1276, tier: "address_point" })
		)

		expect(reading.observed).toBe("equivalent")
		expect(reading.basis).toContain("250 m tolerance")
	})

	it("diverges past the tolerance", () => {
		const reading = compareResults(
			fixture({ resultComparator: "assembled_coordinate", toleranceM: 250 }),
			observed({ lat: 51.5034, lon: -0.1276, tier: "address_point" }),
			observed({ lat: 51.5234, lon: -0.1276, tier: "address_point" })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences[0]).toMatch(/coordinate moved \d+ m/)
	})

	it("diverges on a tier change inside the tolerance", () => {
		const reading = compareResults(
			COORDINATE,
			observed({ lat: 51.5034, lon: -0.1276, tier: "address_point" }),
			observed({ lat: 51.5034, lon: -0.1276, tier: "admin" })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences[0]).toContain("tier address_point → admin")
	})

	it("reads two abstentions as equivalent", () => {
		const reading = compareResults(COORDINATE, observed(), observed())

		expect(reading.observed).toBe("equivalent")
	})

	it("reads base-abstained, variant-resolved as a refinement and the reverse as a divergence", () => {
		const resolved = observed({ lat: 51.5034, lon: -0.1276, tier: "address_point" })

		expect(compareResults(COORDINATE, observed(), resolved).observed).toBe("refines")
		expect(compareResults(COORDINATE, resolved, observed()).observed).toBe("diverges")
	})
})

describe("parse_whole_strict", () => {
	it("holds under a casing-only difference", () => {
		const reading = compareResults(
			STRICT,
			observed({ components: { house_number: "10", street: "Downing Street" } }),
			observed({ components: { house_number: "10", street: "DOWNING STREET" } })
		)

		expect(reading.observed).toBe("equivalent")
	})

	it("diverges on a gained component", () => {
		const reading = compareResults(
			STRICT,
			observed({ components: { house_number: "10", street: "Downing Street" } }),
			observed({ components: { house_number: "10", street: "Downing Street", postcode: "SW1A 2AA" } })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences).toContain('postcode: ∅ → "SW1A 2AA"')
	})

	it("reports undecidable when neither side produced a component", () => {
		const reading = compareResults(STRICT, observed(), observed())

		expect(reading.observed).toBe("undecidable")
		expect(reading.differences[0]).toContain("two empty parses agree about nothing")
	})

	it("treats a blank value as an absent component", () => {
		const reading = compareResults(
			STRICT,
			observed({ components: { street: "Downing Street", unit: "  " } }),
			observed({ components: { street: "Downing Street" } })
		)

		expect(reading.observed).toBe("equivalent")
	})
})

describe("component_map", () => {
	it("delegates the severity reading to the invariance grader", () => {
		const reading = compareResults(
			COMPONENTS,
			observed({ components: { house_number: "10", street: "Downing Street" } }),
			observed({ components: { house_number: "10", street: "Whitehall" } })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.basis).toContain("compareComponents verdict LOST")
	})

	it("reads a contained map with a gained component as a refinement, carrying the severity verdict", () => {
		const reading = compareResults(
			COMPONENTS,
			observed({ components: { locality: "Stockton-on-Tees" } }),
			observed({ components: { locality: "Stockton-on-Tees", postcode: "TS21 4AY" } })
		)

		expect(reading.observed).toBe("refines")
		expect(reading.differences[0]).toContain("variant adds postcode")
		expect(reading.basis).toContain("compareComponents verdict LOST")
	})

	it("holds when nothing moved", () => {
		const components = { house_number: "10", street: "Downing Street" }
		const reading = compareResults(COMPONENTS, observed({ components }), observed({ components }))

		expect(reading.observed).toBe("equivalent")
	})

	it("reports undecidable when neither side produced a component", () => {
		expect(compareResults(COMPONENTS, observed(), observed()).observed).toBe("undecidable")
	})
})

describe("mechanism_shape", () => {
	it("holds on the same shapes in the same boundary order", () => {
		const reading = compareResults(MECHANISM, observed({}, ["retrieval_empty"]), observed({}, ["retrieval_empty"]))

		expect(reading.observed).toBe("equivalent")
	})

	it("diverges when the shapes differ, naming each side", () => {
		const reading = compareResults(
			MECHANISM,
			observed({}, ["clean"]),
			observed({}, ["retrieval_empty", "wrong_instance_detected"])
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences).toContain("only in base: clean")
		expect(reading.differences).toContain("only in variant: retrieval_empty, wrong_instance_detected")
	})

	it("diverges on the same shapes in a different boundary order", () => {
		const reading = compareResults(
			MECHANISM,
			observed({}, ["retrieval_empty", "rank_flip"]),
			observed({}, ["rank_flip", "retrieval_empty"])
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences[0]).toContain("different boundary order")
	})

	it("reads two empty accounts as equivalent — an account that matched no shape is a reading", () => {
		expect(compareResults(MECHANISM, observed({}, []), observed({}, [])).observed).toBe("equivalent")
	})

	it("reports undecidable when an account is missing, naming which side", () => {
		const reading = compareResults(MECHANISM, observed({}, ["clean"]), observed())

		expect(reading.observed).toBe("undecidable")
		expect(reading.basis).toContain("no mechanism account attached to variant")
	})
})

describe("candidate_admissibility", () => {
	const REFINEMENT = fixture({
		law: "refinement-monotonicity",
		base: "Springfield",
		variant: "Springfield, IL",
		resultComparator: "candidate_admissibility",
		expect: "refines",
	})

	function traced(candidates: ReadonlyArray<ResolveNodeTrace>): ConformanceResult {
		return { result: result(), candidates }
	}

	function lookup(ids: number[], over: Partial<ResolveNodeTrace["query"]> = {}): ResolveNodeTrace {
		return {
			tag: "locality",
			value: "Springfield",
			placetype: "locality",
			query: { country: null, parentID: null, postcode: null, regionQualifier: null, limit: 5, ...over },
			checks: [],
			candidates: ids.map((id) => ({
				id,
				name: "Springfield",
				country: "US",
				placetype: "locality",
				score: 1,
				prominence: null,
				importance: null,
				population: null,
				exactMatch: null,
				containedByQualifier: null,
				ranks: {},
			})),
			candidatesTruncated: 0,
			picked: null,
			reachableIn: null,
		}
	}

	it("delegates to the accounting instrument and carries its basis", () => {
		const reading = compareResults(REFINEMENT, traced([lookup([1, 2])]), traced([lookup([2, 1])]))

		expect(reading.comparator).toBe("candidate_admissibility")
		expect(reading.observed).toBe("refines")
		expect(reading.basis).toContain("paired lookup(s)")
	})

	it("reports undecidable when no trace is attached, naming which side and why", () => {
		const reading = compareResults(REFINEMENT, traced([lookup([1])]), observed())

		expect(reading.observed).toBe("undecidable")
		expect(reading.basis).toContain("no resolver trace attached to variant")
		expect(reading.differences[0]).toContain("tracing being off")
	})

	// An empty walk is a reading and an absent trace is not, so two runs that performed no lookup are undecidable.
	it("keeps an empty walk apart from an absent trace", () => {
		const reading = compareResults(REFINEMENT, traced([]), traced([]))

		expect(reading.observed).toBe("undecidable")
		expect(reading.basis).not.toContain("no resolver trace attached")
		expect(reading.differences[0]).toContain("no lookup ran on both sides")
	})
})

describe("compareResults", () => {
	it("throws on a comparator outside the closed set rather than defaulting", () => {
		const handmade: ConformanceFixture = { ...IDENTITY, resultComparator: comparatorName("nearby_enough") }

		expect(() => compareResults(handmade, observed(), observed())).toThrow(/unknown resultComparator/)
	})
})
