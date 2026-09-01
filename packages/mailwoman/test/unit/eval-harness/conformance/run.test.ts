/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The conformance runner's three refusals and its failure line.
 *
 *   `undecidable` must not hold, an empty suite must not pass, and both sides of a law must be observed
 *   independently — a fixture whose base and variant are the same string IS the identity law, and answering
 *   its second side from a cache would turn the strongest nondeterminism check available into a tautology.
 *
 *   `gauntletObserver` is checked against a hand-built `GeocodeResult` so the claim "this runs through the
 *   existing Gauntlet infrastructure" is executed rather than asserted: the observer projects through
 *   `toGauntletResult`, the same projection the board's grader and the warm-engine tools already read.
 */

import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import type { ConformanceOutcome } from "mailwoman/eval-harness/conformance/comparators"
import type { ConformanceFixture } from "mailwoman/eval-harness/conformance/fixture"
import {
	type ConformanceObserver,
	formatConformanceFinding,
	gauntletObserver,
	runConformanceFixtures,
	summarizeConformanceRun,
	tracedGauntletObserver,
} from "mailwoman/eval-harness/conformance/run"
import type { GeocodeResult } from "mailwoman/geocode"
import { describe, expect, it } from "vitest"

function fixture(over: Partial<ConformanceFixture> = {}): ConformanceFixture {
	return {
		id: "cnf-sample-01",
		law: "case-folding-invariance",
		base: "10 Downing Street, London",
		variant: "10 DOWNING STREET, LONDON",
		outcomeComparator: "component_map",
		expect: "equivalent",
		...over,
	}
}

/**
 * An observer that answers from a per-query table and counts its calls. Absent queries answer with an empty parse.
 */
function tableObserver(table: Record<string, Record<string, string>>): {
	observe: ConformanceObserver
	calls: string[]
} {
	const calls: string[] = []

	const observe: ConformanceObserver = async (query) => {
		calls.push(query)

		return {
			result: {
				components: table[query] ?? {},
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
			},
		} satisfies ConformanceOutcome
	}

	return { observe, calls }
}

const HELD_TABLE = {
	"10 Downing Street, London": { house_number: "10", street: "Downing Street" },
	"10 DOWNING STREET, LONDON": { house_number: "10", street: "DOWNING STREET" },
}

describe("runConformanceFixtures", () => {
	it("passes when every law holds", async () => {
		const { observe } = tableObserver(HELD_TABLE)
		const { pass, findings } = await runConformanceFixtures([fixture()], observe)

		expect(pass).toBe(true)
		expect(findings[0]!.held).toBe(true)
		expect(findings[0]!.reading.observed).toBe("equivalent")
	})

	it("fails when the observed relation is not the expected one", async () => {
		const { observe } = tableObserver({
			...HELD_TABLE,
			"10 DOWNING STREET, LONDON": { house_number: "10", street: "Whitehall" },
		})

		const { pass, findings } = await runConformanceFixtures([fixture()], observe)

		expect(pass).toBe(false)
		expect(findings[0]!.reading.observed).toBe("diverges")
	})

	it("counts undecidable as a violation rather than a pass", async () => {
		const { observe } = tableObserver({})
		const { pass, findings } = await runConformanceFixtures([fixture()], observe)

		expect(findings[0]!.reading.observed).toBe("undecidable")
		expect(findings[0]!.held).toBe(false)
		expect(pass).toBe(false)
	})

	it("refuses to report an empty suite as passing", async () => {
		const { observe } = tableObserver(HELD_TABLE)

		expect((await runConformanceFixtures([], observe)).pass).toBe(false)
	})

	it("observes both sides independently, even when they are the same string", async () => {
		const { observe, calls } = tableObserver(HELD_TABLE)
		const same = "10 Downing Street, London"

		await runConformanceFixtures([fixture({ base: same, variant: same })], observe)

		expect(calls).toEqual([same, same])
	})

	it("forwards the fixture's single context to both sides", async () => {
		const seen: Array<Record<string, string> | undefined> = []

		const observe: ConformanceObserver = async (_query, context) => {
			seen.push(context as Record<string, string> | undefined)

			return tableObserver(HELD_TABLE).observe(_query, context)
		}

		await runConformanceFixtures([fixture({ context: { caseCountry: "GB" } })], observe)

		expect(seen).toEqual([{ caseCountry: "GB" }, { caseCountry: "GB" }])
	})
})

describe("summarizeConformanceRun", () => {
	const brokenTable = {
		...HELD_TABLE,
		"10 DOWNING STREET, LONDON": { house_number: "10", street: "Whitehall" },
	}

	it("gates on pass rows only, and reports tracked violations without blocking", async () => {
		const { observe } = tableObserver(brokenTable)

		const { findings } = await runConformanceFixtures(
			[fixture(), fixture({ id: "cnf-tracked-01", status: "improvement_target", bugRef: "#1919" })],
			observe
		)

		const summary = summarizeConformanceRun(findings)

		expect(summary.gated).toBe(1)
		expect(summary.failures.map((finding) => finding.fixture.id)).toEqual(["cnf-sample-01"])
		expect(summary.tracked.map((finding) => finding.fixture.id)).toEqual(["cnf-tracked-01"])
		expect(summary.pass).toBe(false)
	})

	it("passes when the only violations are tracked", async () => {
		const { observe } = tableObserver(brokenTable)

		const { findings } = await runConformanceFixtures(
			[
				fixture({ id: "cnf-ok-01", base: "10 Downing Street, London", variant: "10 Downing Street, London" }),
				fixture({ id: "cnf-tracked-01", status: "known_fail", bugRef: "#1919" }),
			],
			observe
		)

		const summary = summarizeConformanceRun(findings)

		expect(summary.pass).toBe(true)
		expect(summary.tracked).toHaveLength(1)
	})

	it("reports a tracked row whose law now holds instead of leaving it tracked forever", async () => {
		const { observe } = tableObserver(HELD_TABLE)

		const { findings } = await runConformanceFixtures(
			[fixture(), fixture({ id: "cnf-tracked-01", status: "improvement_target", bugRef: "#1919" })],
			observe
		)

		const summary = summarizeConformanceRun(findings)

		expect(summary.newlyHolding.map((finding) => finding.fixture.id)).toEqual(["cnf-tracked-01"])
		expect(summary.tracked).toHaveLength(0)
		expect(summary.pass).toBe(true)
	})

	it("refuses to pass a run with no gating row at all", async () => {
		const { observe } = tableObserver(HELD_TABLE)

		const { findings } = await runConformanceFixtures(
			[fixture({ status: "improvement_target", bugRef: "#1919" })],
			observe
		)

		expect(summarizeConformanceRun(findings).pass).toBe(false)
	})

	it("marks a tracked violation apart from a gated one in the rendered line", async () => {
		const { observe } = tableObserver(brokenTable)

		const { findings } = await runConformanceFixtures(
			[fixture({ status: "improvement_target", bugRef: "#1919" })],
			observe
		)

		const rendered = formatConformanceFinding(findings[0]!)

		expect(rendered).toContain("~ [case-folding-invariance] cnf-sample-01 [improvement_target #1919]")
	})
})

describe("formatConformanceFinding", () => {
	it("names the law, the fixture, the committed row, the comparator and both relations", async () => {
		const { observe } = tableObserver({
			...HELD_TABLE,
			"10 DOWNING STREET, LONDON": { house_number: "10", street: "Whitehall" },
		})

		const { findings } = await runConformanceFixtures(
			[fixture({ rowRef: "gb-golden.jsonl#1", context: { caseCountry: "GB" } })],
			observe
		)

		const rendered = formatConformanceFinding(findings[0]!)

		expect(rendered).toContain("[case-folding-invariance] cnf-sample-01 (row gb-golden.jsonl#1)")
		expect(rendered).toContain("component_map expected equivalent, observed diverges")
		expect(rendered).toContain("compareComponents verdict LOST")
		expect(rendered).toContain('"caseCountry":"GB"')
		expect(rendered).toContain('street: "Downing Street" → "Whitehall"')
	})

	it("carries the mechanism-account vocabulary into the line when the observer supplied one", async () => {
		const shaped: ConformanceObserver = async (query) => ({
			result: (await tableObserver(HELD_TABLE).observe(query, undefined)).result,
			mechanismShapes: query.startsWith("10 D") ? ["clean"] : ["retrieval_empty"],
		})

		const { findings } = await runConformanceFixtures(
			[fixture({ outcomeComparator: "mechanism_shape", base: "10 Downing", variant: "somewhere else" })],
			shaped
		)

		const rendered = formatConformanceFinding(findings[0]!)

		expect(rendered).toContain("base [clean] · variant [retrieval_empty]")
		expect(rendered).toContain("only in variant: retrieval_empty")
	})
})

describe("gauntletObserver", () => {
	it("projects a geocode through the Gauntlet's own toGauntletResult", async () => {
		const geocode = async (input: string): Promise<GeocodeResult> => ({
			input,
			components: { house_number: "10", street: "Downing Street" },
			lat: 51.5034,
			lon: -0.1276,
			resolution_tier: "address_point",
			uncertainty_m: 12,
			locality: "London",
			region: null,
			countryCode: "GB",
			intent_markers: [],
			postcode: "SW1A 2AA",
			house_number: "10",
			street: "Downing Street",
			venue: null,
			dependent_locality: null,
			unit: null,
			hierarchy: [
				{ tag: "locality", value: "London", name: "London", placeID: "wof:101750367" },
				{ tag: "country", value: "United Kingdom", name: "United Kingdom", placeID: "wof:85633159" },
			],
			candidates: [],
			postcode_country_scope: null,
		})

		const outcome = await gauntletObserver(geocode)("10 Downing Street, London", { caseCountry: "GB" })

		expect(outcome.result.tier).toBe("address_point")
		expect(outcome.result.country).toBe("United Kingdom")
		expect(outcome.result.hierarchy[0]?.placeID).toBe("wof:101750367")
		// No mechanism account: the shape vocabulary lives in the private dev-mcp workspace, so a shape-carrying
		// observer is the caller's to supply. Absent, not empty.
		expect(outcome.mechanismShapes).toBeUndefined()
		// And no resolver trace either: the walk records nothing unless a sink asks it to, and this observer does
		// not ask. Absent, not an empty walk — the distinction `candidate_admissibility` reads.
		expect(outcome.candidates).toBeUndefined()
	})
})

describe("tracedGauntletObserver", () => {
	const tracedGeocode = async (input: string): Promise<{ result: GeocodeResult; resolver: ResolveNodeTrace[] }> => ({
		result: {
			input,
			components: { locality: "Springfield" },
			lat: 39.797328,
			lon: -89.645547,
			resolution_tier: "admin",
			uncertainty_m: 25_000,
			locality: "Springfield",
			region: null,
			countryCode: "US",
			intent_markers: [],
			postcode: null,
			house_number: null,
			street: null,
			venue: null,
			dependent_locality: null,
			unit: null,
			hierarchy: [],
			candidates: [],
			postcode_country_scope: null,
		},
		resolver: [
			{
				tag: "locality",
				value: "Springfield",
				placetype: "locality",
				query: { limit: 5 },
				gates: ["bare_race"],
				candidates: [
					{
						id: 85_940_429,
						name: "Springfield",
						country: "US",
						placetype: "locality",
						score: 5,
						ranks: { initial: 1 },
					},
				],
				candidatesTruncated: 0,
				picked: { id: 85_940_429, name: "Springfield", source: "ranked" },
			},
		],
	})

	it("attaches the resolver's own records, projecting the result through the same mapping", async () => {
		const outcome = await tracedGauntletObserver(tracedGeocode)("Springfield", { caseCountry: "US" })

		expect(outcome.result.locality).toBe("Springfield")
		expect(outcome.candidates).toHaveLength(1)
		expect(outcome.candidates![0]!.candidates[0]!.id).toBe(85_940_429)
		expect(outcome.candidates![0]!.query.limit).toBe(5)
	})

	it("reads a refinement pair end to end, through the closed comparator set", async () => {
		const { findings } = await runConformanceFixtures(
			[
				fixture({
					id: "cnf-candidate-01",
					law: "refinement-monotonicity",
					base: "Springfield",
					variant: "Springfield",
					outcomeComparator: "candidate_admissibility",
					expect: "refines",
				}),
			],
			tracedGauntletObserver(tracedGeocode)
		)

		expect(findings[0]!.reading.observed).toBe("refines")
		expect(findings[0]!.held).toBe(true)
		expect(formatConformanceFinding(findings[0]!)).toContain("1 paired lookup(s)")
	})
})

describe("the unmeasured verdict bucket", () => {
	/**
	 * A pair whose refined table sits at its window with a base candidate missing — the one shape that reads `unmeasured`
	 * rather than deciding.
	 */
	const unmeasuredObserver: ConformanceObserver = async (query) => ({
		result: (await tableObserver(HELD_TABLE).observe(query, undefined)).result,
		candidates: [
			{
				tag: "locality",
				value: "Springfield",
				placetype: "locality",
				query: { limit: query === "Springfield" ? 5 : 1 },
				gates: [],
				candidates:
					query === "Springfield"
						? [
								{ id: 1, name: "a", country: "US", placetype: "locality", score: 1, ranks: {} },
								{ id: 2, name: "b", country: "US", placetype: "locality", score: 1, ranks: {} },
							]
						: [{ id: 1, name: "a", country: "US", placetype: "locality", score: 1, ranks: {} }],
				candidatesTruncated: 0,
				picked: null,
			},
		],
	})

	const unmeasuredFixture = fixture({
		law: "refinement-monotonicity",
		base: "Springfield",
		variant: "Springfield, IL",
		outcomeComparator: "candidate_admissibility",
		expect: "refines",
	})

	it("leaves the row out of the count the verdict is stated over", async () => {
		const { findings } = await runConformanceFixtures([unmeasuredFixture], unmeasuredObserver)
		const summary = summarizeConformanceRun(findings)

		expect(findings[0]!.reading.observed).toBe("unmeasured")
		expect(summary.unmeasured).toHaveLength(1)
		expect(summary.failures).toHaveLength(0)
		expect(summary.gated).toBe(0)
		// A suite that could measure nothing at all is not a clean suite — the same refusal an empty suite gets.
		expect(summary.pass).toBe(false)
	})

	it("never reports an unmeasured tracked row as newly holding", async () => {
		const { findings } = await runConformanceFixtures(
			[{ ...unmeasuredFixture, status: "known_fail", bugRef: "#1923" }],
			unmeasuredObserver
		)

		const summary = summarizeConformanceRun(findings)

		expect(summary.unmeasured).toHaveLength(1)
		expect(summary.newlyHolding).toHaveLength(0)
		expect(summary.tracked).toHaveLength(0)
	})

	it("marks the line so a reader cannot mistake it for a hold or a failure", async () => {
		const { findings } = await runConformanceFixtures([unmeasuredFixture], unmeasuredObserver)

		expect(formatConformanceFinding(findings[0]!).startsWith("? ")).toBe(true)
	})

	it("leaves the four answer-axis laws exactly as they were", async () => {
		const { findings } = await runConformanceFixtures([fixture()], tableObserver(HELD_TABLE).observe)
		const summary = summarizeConformanceRun(findings)

		expect(summary.unmeasured).toEqual([])
		expect(summary.gated).toBe(1)
		expect(summary.pass).toBe(true)
	})
})
