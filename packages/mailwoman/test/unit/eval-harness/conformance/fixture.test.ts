/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The conformance-law fixture contract's refusals. Every case here is a row that must NOT load, because
 *   the alternative to a refusal is a row that grades under a default nobody wrote and reports as authored.
 *
 *   The required pair is `rejects a fixture with no comparator` and `rejects an unknown comparator`:
 *   between them they are the whole reason the comparator set is closed, and both messages must carry the
 *   fixture's own id — a refusal that does not name the row sends the reader to a file with no line to open.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import {
	CONFORMANCE_RELATIONS,
	type ConformanceFixture,
	loadConformanceFixtures,
	OUTCOME_COMPARATORS,
	parseConformanceFixture,
	RELATIONS_BY_COMPARATOR,
} from "mailwoman/eval-harness/conformance/fixture"
import { describe, expect, it } from "vitest"

const EXAMPLE_SUITE = String(
	repoRootPath("packages", "mailwoman", "test-fixtures", "conformance", "contract-example.jsonl")
)

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
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

function writeSuite(rows: ReadonlyArray<Record<string, unknown>>): string {
	const dir = mkdtempSync(join(tmpdir(), "mw-conformance-"))
	const path = join(dir, "suite.jsonl")

	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)

	return path
}

describe("conformance fixture vocabulary", () => {
	it("closes the comparator set at six named instruments", () => {
		expect([...OUTCOME_COMPARATORS]).toEqual([
			"resolution_identity",
			"assembled_coordinate",
			"parse_whole_strict",
			"component_map",
			"mechanism_shape",
			"candidate_admissibility",
		])
	})

	it("refuses candidate_admissibility the relation it cannot report", () => {
		expect(RELATIONS_BY_COMPARATOR["candidate_admissibility"]).toEqual(["refines", "diverges"])

		expect(() =>
			parseConformanceFixture(record({ outcomeComparator: "candidate_admissibility", expect: "equivalent" }), "inline")
		).toThrow(/cannot express the relation "equivalent"/)
	})

	it("declares supported relations for every comparator", () => {
		for (const comparator of OUTCOME_COMPARATORS) {
			const supported = RELATIONS_BY_COMPARATOR[comparator]

			expect(supported.length).toBeGreaterThan(0)

			for (const relation of supported) {
				expect(CONFORMANCE_RELATIONS).toContain(relation)
			}
		}
	})
})

describe("parseConformanceFixture", () => {
	it("accepts a minimal row", () => {
		const fixture = parseConformanceFixture(record(), "inline")

		expect(fixture.id).toBe("cnf-sample-01")
		expect(fixture.outcomeComparator).toBe("resolution_identity")
		expect(fixture.expect).toBe("equivalent")
		expect(fixture.context).toBeUndefined()
	})

	it("rejects a fixture with no comparator, naming the fixture and the closed set", () => {
		const raw = record()
		delete raw["outcomeComparator"]

		expect(() => parseConformanceFixture(raw, "inline")).toThrow(/cnf-sample-01/)
		expect(() => parseConformanceFixture(raw, "inline")).toThrow(/"outcomeComparator" is required/)
		expect(() => parseConformanceFixture(raw, "inline")).toThrow(/mechanism_shape/)
	})

	it("rejects an unknown comparator rather than skipping the row", () => {
		expect(() => parseConformanceFixture(record({ outcomeComparator: "nearby_enough" }), "inline")).toThrow(
			/cnf-sample-01.*unknown outcomeComparator "nearby_enough"/s
		)
	})

	it("names the origin when the row has no usable id", () => {
		const raw = record()
		delete raw["id"]

		expect(() => parseConformanceFixture(raw, "suite.jsonl:7")).toThrow(/suite\.jsonl:7: fixture \(no id\)/)
	})

	it("rejects an unknown relation", () => {
		expect(() => parseConformanceFixture(record({ expect: "close_enough" }), "inline")).toThrow(
			/unknown expect "close_enough"/
		)
	})

	it("rejects a relation the named comparator cannot express", () => {
		const raw = record({ outcomeComparator: "parse_whole_strict", expect: "refines" })

		expect(() => parseConformanceFixture(raw, "inline")).toThrow(
			/comparator "parse_whole_strict" cannot express the relation "refines"/
		)
	})

	it("rejects an unknown top-level field instead of dropping it", () => {
		expect(() => parseConformanceFixture(record({ comparator: "component_map" }), "inline")).toThrow(
			/unknown field "comparator"/
		)
	})

	it("rejects an unknown context key instead of dropping it", () => {
		expect(() => parseConformanceFixture(record({ context: { defaultCounty: "GB" } }), "inline")).toThrow(
			/unknown context key "defaultCounty"/
		)
	})

	it("keeps a well-formed context", () => {
		const fixture = parseConformanceFixture(record({ context: { caseCountry: "GB", defaultCountry: "GB" } }), "inline")

		expect(fixture.context).toEqual({ caseCountry: "GB", defaultCountry: "GB" })
	})

	it("rejects a tolerance the named comparator never reads", () => {
		expect(() => parseConformanceFixture(record({ toleranceM: 250 }), "inline")).toThrow(
			/only read by the assembled_coordinate comparator/
		)
	})

	it("accepts a tolerance on the comparator that reads it", () => {
		const raw = record({ outcomeComparator: "assembled_coordinate", toleranceM: 250 })

		expect(parseConformanceFixture(raw, "inline").toleranceM).toBe(250)
	})

	it("rejects a non-positive tolerance", () => {
		const raw = record({ outcomeComparator: "assembled_coordinate", toleranceM: 0 })

		expect(() => parseConformanceFixture(raw, "inline")).toThrow(/must be a positive finite number/)
	})

	it("defaults an unstated status to gating rather than to tracked", () => {
		const fixture = parseConformanceFixture(record(), "inline")

		expect(fixture.status).toBeUndefined()
		expect(fixture.bugRef).toBeUndefined()
	})

	it("rejects an unknown status rather than reading it as tracked", () => {
		expect(() => parseConformanceFixture(record({ status: "xfail" }), "inline")).toThrow(
			/cnf-sample-01.*unknown status "xfail".*pass, known_fail, improvement_target/s
		)
	})

	it.each(["known_fail", "improvement_target"])("carries the tracked status %s with its reference", (status) => {
		const fixture = parseConformanceFixture(record({ status, bugRef: "#1919" }), "inline")

		expect(fixture.status).toBe(status)
		expect(fixture.bugRef).toBe("#1919")
	})

	it("rejects a bugRef on a gating row — a row expected to hold cannot also name a defect", () => {
		expect(() => parseConformanceFixture(record({ bugRef: "#1919" }), "inline")).toThrow(
			/only meaningful on a tracked row, and this row's status is "pass"/
		)

		expect(() => parseConformanceFixture(record({ status: "pass", bugRef: "#1919" }), "inline")).toThrow(
			/only meaningful on a tracked row/
		)
	})

	it.each(["id", "law", "base", "variant"])("rejects a blank %s", (key) => {
		expect(() => parseConformanceFixture(record({ [key]: "   " }), "inline")).toThrow(
			new RegExp(`"${key}" must be a non-empty string`)
		)
	})

	it("rejects a non-object row", () => {
		expect(() => parseConformanceFixture("10 Downing Street", "inline")).toThrow(/must be an object/)
	})
})

describe("loadConformanceFixtures", () => {
	it("loads the worked example, exercising every comparator once", async () => {
		const fixtures = await loadConformanceFixtures(EXAMPLE_SUITE)
		const used = fixtures.map((fixture) => fixture.outcomeComparator)

		expect(fixtures).toHaveLength(OUTCOME_COMPARATORS.length)
		expect(used.toSorted()).toEqual([...OUTCOME_COMPARATORS].toSorted())
	})

	it("carries the optional row reference and per-row context through", async () => {
		const fixtures = await loadConformanceFixtures(EXAMPLE_SUITE)
		const identity = fixtures.find((fixture) => fixture.id === "cnf-identity-01") as ConformanceFixture

		expect(identity.rowRef).toBe("gb-golden.jsonl#1")
		expect(identity.context).toEqual({ caseCountry: "GB" })
	})

	it("holds a genuine NFC/NFD pair — the two sides differ by code point and agree after normalization", async () => {
		const fixtures = await loadConformanceFixtures(EXAMPLE_SUITE)
		const nfc = fixtures.find((fixture) => fixture.id === "cnf-parse-strict-01") as ConformanceFixture

		expect(nfc.base).not.toBe(nfc.variant)
		expect(nfc.base).toBe(nfc.variant.normalize("NFC"))
	})

	it("refuses a duplicate id", async () => {
		const path = writeSuite([record(), record({ law: "whitespace-invariance" })])

		await expect(loadConformanceFixtures(path)).rejects.toThrow(/duplicate fixture id "cnf-sample-01"/)
	})

	it("refuses the whole suite on one bad row rather than loading the good ones", async () => {
		const path = writeSuite([record(), record({ id: "cnf-sample-02", outcomeComparator: "vibes" })])

		await expect(loadConformanceFixtures(path)).rejects.toThrow(/cnf-sample-02.*unknown outcomeComparator/s)
	})
})
