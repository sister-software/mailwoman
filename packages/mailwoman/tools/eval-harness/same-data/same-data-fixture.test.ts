/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The same-data benchmark's evidence interface. A replay miss raises, because the resolver absorbs
 *   an empty list silently and the arm would then report an abstention the fixture produced. A
 *   candidate carrying a withheld verdict field is refused, since shipping one hands every arm a
 *   partly solved row. The pool is the ordered candidate set every arm is judged to have received.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import {
	assertEqualEvidence,
	candidatePool,
	canonicalQueryKey,
	fixtureRowDigest,
	observeEvidence,
	replayBackend,
	SAME_DATA_SCHEMA_VERSION,
	type SameDataCandidate,
	type SameDataFixtureRow,
	type SameDataPanelRow,
	validateFixture,
} from "#tools/eval-harness/same-data/fixture"

function candidate(id: number, name: string, country: string, lat: number, lon: number): SameDataCandidate {
	return { ...EMPTY_PLACE_FIELDS, id, name, placetype: "locality", country, lat, lon, score: 10 }
}

const TREE: AddressTree = {
	raw: "Whitby",
	roots: [{ tag: "locality", value: "Whitby", start: 0, end: 6, confidence: 0.9, children: [] }],
}

const WHITBY_CA = candidate(101, "Whitby", "CA", 43.88, -78.94)
const WHITBY_GB = candidate(202, "Whitby", "GB", 54.49, -0.62)

function fixtureRow(overrides: Partial<SameDataFixtureRow> = {}): SameDataFixtureRow {
	const lookups = [
		{
			key: canonicalQueryKey({ text: "Whitby", placetype: "locality", limit: 5 }),
			query: { text: "Whitby", placetype: "locality", limit: 5 },
			candidates: [WHITBY_CA, WHITBY_GB],
		},
	]

	return {
		id: "row-1",
		schemaVersion: SAME_DATA_SCHEMA_VERSION,
		tree: TREE,
		lookups,
		pool: candidatePool(lookups),
		...overrides,
	}
}

const PANEL: SameDataPanelRow[] = [
	{
		id: "row-1",
		stratum: "unambiguous",
		query: "Whitby",
		goldPresent: true,
		gold: {
			geonameid: "6182962",
			placeIDs: [101],
			name: "Whitby",
			country: "CA",
			admin1: "08",
			lat: 43.88,
			lon: -78.94,
			population: 128_377,
		},
		source: { register: "geonames:cities15000", license: "CC-BY-4.0", attribution: "GeoNames" },
	},
]

describe("same-data fixture interface (#2261)", () => {
	it("accepts a well-formed fixture", () => {
		expect(validateFixture(PANEL, [fixtureRow()])).toEqual([])
	})

	it("refuses a candidate carrying a withheld verdict field", () => {
		const row = fixtureRow()
		const poisoned = { ...WHITBY_CA, containedByQualifier: true } as SameDataCandidate
		const lookups = [{ ...row.lookups[0]!, candidates: [poisoned, WHITBY_GB] }]
		const problems = validateFixture(PANEL, [{ ...row, lookups, pool: candidatePool(lookups) }])

		expect(problems.map((problem) => problem.problem).join(" ")).toContain("withheld field containedByQualifier")
	})

	it("refuses a pool that is not the canonical union of the lookups", () => {
		const row = fixtureRow()
		const problems = validateFixture(PANEL, [{ ...row, pool: [WHITBY_GB] }])

		expect(problems.map((problem) => problem.problem).join(" ")).toContain("pool is not the canonical union")
	})

	it("refuses a lookup key that does not match its own query", () => {
		const row = fixtureRow()
		const lookups = [{ ...row.lookups[0]!, key: "{}" }]
		const problems = validateFixture(PANEL, [{ ...row, lookups }])

		expect(problems.map((problem) => problem.problem).join(" ")).toContain("does not match its query")
	})

	it("reports every arm reading one row as equal evidence", () => {
		const row = fixtureRow()
		const observations = ["mailwoman", "baseline", "ablation"].map((arm) => observeEvidence(arm, row))

		expect(assertEqualEvidence(observations)).toEqual([])
	})

	it("refuses arms that read different candidate sets for the same row", () => {
		const row = fixtureRow()
		const trimmedLookups = [{ ...row.lookups[0]!, candidates: [WHITBY_CA] }]
		const trimmed: SameDataFixtureRow = { ...row, lookups: trimmedLookups, pool: candidatePool(trimmedLookups) }

		const problems = assertEqualEvidence([observeEvidence("mailwoman", row), observeEvidence("baseline", trimmed)])
		const text = problems.map((problem) => problem.problem).join(" ")

		expect(text).toContain("saw 1 candidates")
		expect(text).toContain("different candidate ids")
		expect(text).toContain("fixture digest")
	})

	it("gives one row's evidence a digest that moves when any candidate field moves", () => {
		const row = fixtureRow()

		const nudgedLookups = [{ ...row.lookups[0]!, candidates: [{ ...WHITBY_CA, score: 11 }, WHITBY_GB] }]

		expect(fixtureRowDigest({ ...row, lookups: nudgedLookups, pool: candidatePool(nudgedLookups) })).not.toEqual(
			fixtureRowDigest(row)
		)
	})

	it("answers a recorded query from the fixture", async () => {
		const backend = replayBackend(fixtureRow())
		const hits = await backend.findPlace({ text: "Whitby", placetype: "locality", limit: 5 })

		expect(hits.map((hit) => hit.id)).toEqual([101, 202])
	})

	it("raises on a replay miss rather than answering an empty list", async () => {
		const backend = replayBackend(fixtureRow())

		await expect(backend.findPlace({ text: "Whitby", placetype: "region", limit: 5 })).rejects.toThrow(
			/holds no answer/
		)
	})

	it("hands each caller its own array so an in-place sort cannot reorder the frozen evidence", async () => {
		const backend = replayBackend(fixtureRow())
		const first = await backend.findPlace({ text: "Whitby", placetype: "locality", limit: 5 })

		first.reverse()

		const second = await backend.findPlace({ text: "Whitby", placetype: "locality", limit: 5 })

		expect(second.map((hit) => hit.id)).toEqual([101, 202])
	})

	it("keys a query by content rather than by the order its fields were written", () => {
		expect(canonicalQueryKey({ text: "Whitby", limit: 5, placetype: "locality" })).toEqual(
			canonicalQueryKey({ placetype: "locality", text: "Whitby", limit: 5 })
		)
	})
})
