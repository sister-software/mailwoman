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

import type { ConformanceOutcome } from "mailwoman/eval-harness/conformance/comparators"
import type { ConformanceFixture } from "mailwoman/eval-harness/conformance/fixture"
import {
	type ConformanceObserver,
	formatConformanceFinding,
	gauntletObserver,
	runConformanceFixtures,
	summarizeConformanceRun,
} from "mailwoman/eval-harness/conformance/run"
import type { GeocodeResult } from "mailwoman/geocode-core"
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
	})
})
