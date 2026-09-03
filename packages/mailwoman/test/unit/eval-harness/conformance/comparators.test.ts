/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The six outcome comparators, one axis at a time.
 *
 *   Two cases carry the design and the rest are coverage. `resolution_identity` must report `diverges` for two
 *   DIFFERENT places 90 metres apart — an identity law that could see a coordinate would call that pair
 *   equivalent, which is the whole failure the closed comparator set exists to prevent. And every comparator
 *   whose axis is absent on both sides must report `undecidable`, never `equivalent`: two runs that resolved
 *   nothing agree about nothing, and a suite that scored that as a pass would report the same total as one
 *   whose laws genuinely held.
 */

import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import { compareOutcomes, type ConformanceOutcome } from "mailwoman/eval-harness/conformance/comparators"
import type { ConformanceFixture } from "mailwoman/eval-harness/conformance/fixture"
import type { GauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import { describe, expect, it } from "vitest"

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
		hierarchy: [],
		...over,
	}
}

function outcome(over: Partial<GauntletResult> = {}, mechanismShapes?: readonly string[]): ConformanceOutcome {
	return mechanismShapes ? { result: result(over), mechanismShapes } : { result: result(over) }
}

function fixture(over: Partial<ConformanceFixture> = {}): ConformanceFixture {
	return {
		id: "cnf-sample-01",
		law: "case-folding-invariance",
		base: "10 Downing Street, London",
		variant: "10 DOWNING STREET, LONDON",
		outcomeComparator: "resolution_identity",
		expect: "equivalent",
		...over,
	}
}

/**
 * Force a name onto the closed comparator union. Only a fixture built by hand — skipping the loader, which refuses an
 * unknown name — can reach a comparator with one, and that is the path under test below.
 */
function comparatorName(value: string): ConformanceFixture["outcomeComparator"] {
	return value as ConformanceFixture["outcomeComparator"]
}

const IDENTITY = fixture()
const COORDINATE = fixture({ outcomeComparator: "assembled_coordinate" })
const STRICT = fixture({ outcomeComparator: "parse_whole_strict" })
const COMPONENTS = fixture({ outcomeComparator: "component_map" })
const MECHANISM = fixture({ outcomeComparator: "mechanism_shape" })

const LONDON = [
	{ tag: "locality", name: "London", placeID: "wof:101750367" },
	{ tag: "country", name: "United Kingdom", placeID: "wof:85633159" },
]

describe("resolution_identity", () => {
	it("reads the same chain as equivalent", () => {
		const reading = compareOutcomes(IDENTITY, outcome({ hierarchy: LONDON }), outcome({ hierarchy: LONDON }))

		expect(reading.observed).toBe("equivalent")
		expect(reading.differences).toEqual([])
	})

	it("diverges on two different places 90 metres apart — a coordinate is never read", () => {
		const near = [
			{ tag: "locality", name: "London", placeID: "wof:404227469", lat: 51.5015, lon: -0.1246 },
			{ tag: "country", name: "United Kingdom", placeID: "wof:85633159" },
		]

		const reading = compareOutcomes(
			IDENTITY,
			outcome({ hierarchy: LONDON, lat: 51.5007, lon: -0.1246 }),
			outcome({ hierarchy: near, lat: 51.5015, lon: -0.1246 })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.basis).toContain("coordinates not read")
	})

	it("reads a chain extended at the fine end as a refinement", () => {
		const deeper = [{ tag: "dependent_locality", name: "Westminster", placeID: "wof:85681877" }, ...LONDON]
		const reading = compareOutcomes(IDENTITY, outcome({ hierarchy: LONDON }), outcome({ hierarchy: deeper }))

		expect(reading.observed).toBe("refines")
		expect(reading.differences[0]).toContain("dependent_locality:wof:85681877")
	})

	it("reports undecidable when neither side carries a place identity", () => {
		const nameOnly = [{ tag: "locality", name: "London" }]
		const reading = compareOutcomes(IDENTITY, outcome({ hierarchy: nameOnly }), outcome({ hierarchy: nameOnly }))

		expect(reading.observed).toBe("undecidable")
		expect(reading.basis).toContain("1 unverifiable")
	})
})

describe("assembled_coordinate", () => {
	it("holds inside the fixture's own tolerance at an unchanged tier", () => {
		const reading = compareOutcomes(
			fixture({ outcomeComparator: "assembled_coordinate", toleranceM: 250 }),
			outcome({ lat: 51.5034, lon: -0.1276, tier: "address_point" }),
			outcome({ lat: 51.5035, lon: -0.1276, tier: "address_point" })
		)

		expect(reading.observed).toBe("equivalent")
		expect(reading.basis).toContain("250 m tolerance")
	})

	it("diverges past the tolerance", () => {
		const reading = compareOutcomes(
			fixture({ outcomeComparator: "assembled_coordinate", toleranceM: 250 }),
			outcome({ lat: 51.5034, lon: -0.1276, tier: "address_point" }),
			outcome({ lat: 51.5234, lon: -0.1276, tier: "address_point" })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences[0]).toMatch(/coordinate moved \d+ m/)
	})

	it("diverges on a tier change inside the tolerance", () => {
		const reading = compareOutcomes(
			COORDINATE,
			outcome({ lat: 51.5034, lon: -0.1276, tier: "address_point" }),
			outcome({ lat: 51.5034, lon: -0.1276, tier: "admin" })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences[0]).toContain("tier address_point → admin")
	})

	it("reads two abstentions as equivalent", () => {
		const reading = compareOutcomes(COORDINATE, outcome(), outcome())

		expect(reading.observed).toBe("equivalent")
	})

	it("reads base-abstained, variant-resolved as a refinement and the reverse as a divergence", () => {
		const resolved = outcome({ lat: 51.5034, lon: -0.1276, tier: "address_point" })

		expect(compareOutcomes(COORDINATE, outcome(), resolved).observed).toBe("refines")
		expect(compareOutcomes(COORDINATE, resolved, outcome()).observed).toBe("diverges")
	})
})

describe("parse_whole_strict", () => {
	it("holds under a casing-only difference", () => {
		const reading = compareOutcomes(
			STRICT,
			outcome({ components: { house_number: "10", street: "Downing Street" } }),
			outcome({ components: { house_number: "10", street: "DOWNING STREET" } })
		)

		expect(reading.observed).toBe("equivalent")
	})

	it("diverges on a gained component", () => {
		const reading = compareOutcomes(
			STRICT,
			outcome({ components: { house_number: "10", street: "Downing Street" } }),
			outcome({ components: { house_number: "10", street: "Downing Street", postcode: "SW1A 2AA" } })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences).toContain('postcode: ∅ → "SW1A 2AA"')
	})

	it("reports undecidable when neither side produced a component", () => {
		const reading = compareOutcomes(STRICT, outcome(), outcome())

		expect(reading.observed).toBe("undecidable")
		expect(reading.differences[0]).toContain("two empty parses agree about nothing")
	})

	it("treats a blank value as an absent component", () => {
		const reading = compareOutcomes(
			STRICT,
			outcome({ components: { street: "Downing Street", unit: "  " } }),
			outcome({ components: { street: "Downing Street" } })
		)

		expect(reading.observed).toBe("equivalent")
	})
})

describe("component_map", () => {
	it("delegates the severity reading to the invariance grader", () => {
		const reading = compareOutcomes(
			COMPONENTS,
			outcome({ components: { house_number: "10", street: "Downing Street" } }),
			outcome({ components: { house_number: "10", street: "Whitehall" } })
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.basis).toContain("compareComponents verdict LOST")
	})

	it("reads a contained map with a gained component as a refinement, carrying the severity verdict", () => {
		const reading = compareOutcomes(
			COMPONENTS,
			outcome({ components: { locality: "Stockton-on-Tees" } }),
			outcome({ components: { locality: "Stockton-on-Tees", postcode: "TS21 4AY" } })
		)

		expect(reading.observed).toBe("refines")
		expect(reading.differences[0]).toContain("variant adds postcode")
		expect(reading.basis).toContain("compareComponents verdict LOST")
	})

	it("holds when nothing moved", () => {
		const components = { house_number: "10", street: "Downing Street" }
		const reading = compareOutcomes(COMPONENTS, outcome({ components }), outcome({ components }))

		expect(reading.observed).toBe("equivalent")
	})

	it("reports undecidable when neither side produced a component", () => {
		expect(compareOutcomes(COMPONENTS, outcome(), outcome()).observed).toBe("undecidable")
	})
})

describe("mechanism_shape", () => {
	it("holds on the same shapes in the same boundary order", () => {
		const reading = compareOutcomes(MECHANISM, outcome({}, ["retrieval_empty"]), outcome({}, ["retrieval_empty"]))

		expect(reading.observed).toBe("equivalent")
	})

	it("diverges when the shapes differ, naming each side", () => {
		const reading = compareOutcomes(
			MECHANISM,
			outcome({}, ["clean"]),
			outcome({}, ["retrieval_empty", "wrong_instance_detected"])
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences).toContain("only in base: clean")
		expect(reading.differences).toContain("only in variant: retrieval_empty, wrong_instance_detected")
	})

	it("diverges on the same shapes in a different boundary order", () => {
		const reading = compareOutcomes(
			MECHANISM,
			outcome({}, ["retrieval_empty", "rank_flip"]),
			outcome({}, ["rank_flip", "retrieval_empty"])
		)

		expect(reading.observed).toBe("diverges")
		expect(reading.differences[0]).toContain("different boundary order")
	})

	it("reads two empty accounts as equivalent — an account that matched no shape is a reading", () => {
		expect(compareOutcomes(MECHANISM, outcome({}, []), outcome({}, [])).observed).toBe("equivalent")
	})

	it("reports undecidable when an account is missing, naming which side", () => {
		const reading = compareOutcomes(MECHANISM, outcome({}, ["clean"]), outcome())

		expect(reading.observed).toBe("undecidable")
		expect(reading.basis).toContain("no mechanism account attached to variant")
	})
})

describe("candidate_admissibility", () => {
	const REFINEMENT = fixture({
		law: "refinement-monotonicity",
		base: "Springfield",
		variant: "Springfield, IL",
		outcomeComparator: "candidate_admissibility",
		expect: "refines",
	})

	function traced(candidates: ReadonlyArray<ResolveNodeTrace>): ConformanceOutcome {
		return { result: result(), candidates }
	}

	function lookup(ids: number[], over: Partial<ResolveNodeTrace["query"]> = {}): ResolveNodeTrace {
		return {
			tag: "locality",
			value: "Springfield",
			placetype: "locality",
			query: { limit: 5, ...over },
			checks: [],
			candidates: ids.map((id) => ({
				id,
				name: "Springfield",
				country: "US",
				placetype: "locality",
				score: 1,
				ranks: {},
			})),
			candidatesTruncated: 0,
			picked: null,
		}
	}

	it("delegates to the accounting instrument and carries its basis", () => {
		const reading = compareOutcomes(REFINEMENT, traced([lookup([1, 2])]), traced([lookup([2, 1])]))

		expect(reading.comparator).toBe("candidate_admissibility")
		expect(reading.observed).toBe("refines")
		expect(reading.basis).toContain("paired lookup(s)")
	})

	it("reports undecidable when no trace is attached, naming which side and why", () => {
		const reading = compareOutcomes(REFINEMENT, traced([lookup([1])]), outcome())

		expect(reading.observed).toBe("undecidable")
		expect(reading.basis).toContain("no resolver trace attached to variant")
		expect(reading.differences[0]).toContain("tracing being off")
	})

	// The distinction the mechanism-shape comparator keeps for its own axis: an empty walk is a reading, an
	// absent trace is not. Two runs that performed no lookup share no pool, so they are undecidable — not the
	// absence of a trace, and not agreement.
	it("keeps an empty walk apart from an absent trace", () => {
		const reading = compareOutcomes(REFINEMENT, traced([]), traced([]))

		expect(reading.observed).toBe("undecidable")
		expect(reading.basis).not.toContain("no resolver trace attached")
		expect(reading.differences[0]).toContain("no lookup ran on both sides")
	})
})

describe("compareOutcomes", () => {
	it("throws on a comparator outside the closed set rather than defaulting", () => {
		const handmade: ConformanceFixture = { ...IDENTITY, outcomeComparator: comparatorName("nearby_enough") }

		expect(() => compareOutcomes(handmade, outcome(), outcome())).toThrow(/unknown outcomeComparator/)
	})
})
