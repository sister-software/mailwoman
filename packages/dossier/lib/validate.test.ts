/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import type { LayerReading } from "#coverage"
import type { EntityID } from "#identifiers"
import { EMPTY_RECORDS, EXAMPLE_RECORDS, HOUSE, NORTH } from "#test/fixtures/example-house"
import { validateRecords } from "#validate"

function readingFor(subject: EntityID): LayerReading {
	return { layer: "ducts", extent: "cell-1", subject, basis: null, records: null, evidence: { source: "survey-2022" } }
}

describe("validateRecords", () => {
	test("the example records produce warnings only", () => {
		const issues = validateRecords(EXAMPLE_RECORDS)

		expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
		expect(issues.map((issue) => issue.code)).toContain("source_without_available_date")
		expect(issues.map((issue) => issue.code)).toContain("signing_authority_unknown")
	})

	test("a claim citing an unknown source is an error", () => {
		const issues = validateRecords({
			...EMPTY_RECORDS,
			sources: EXAMPLE_RECORDS.sources,
			entities: EXAMPLE_RECORDS.entities,
			claims: [
				{
					id: "x",
					subject: "building:example-house",
					axis: "premises",
					predicate: "storeys",
					value: 13,
					status: "observed",
					evidence: { source: "no-such-source" },
				},
			],
		})

		expect(issues).toContainEqual(expect.objectContaining({ severity: "error", code: "unknown_source", ref: "x" }))
	})

	test("a malformed date is an error", () => {
		const issues = validateRecords({
			...EMPTY_RECORDS,
			sources: [{ id: "s", publisher: "p", title: "t", availableAt: "03/01/2022" }],
		})

		expect(issues).toContainEqual(expect.objectContaining({ severity: "error", code: "malformed_date", ref: "s" }))
	})

	test("an event without a date is a warning", () => {
		expect(validateRecords(EXAMPLE_RECORDS)).toContainEqual(
			expect.objectContaining({ severity: "warning", code: "event_without_date", ref: "e5" })
		)
	})
})

describe("validateRecords: a layer reading's subject", () => {
	test("a supplied building is accepted", () => {
		const issues = validateRecords({ ...EXAMPLE_RECORDS, readings: [readingFor(HOUSE)] })

		expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
	})

	test("an identifier that names no supplied entity is an unknown_entity error", () => {
		expect(validateRecords({ ...EXAMPLE_RECORDS, readings: [readingFor("building:ghost")] })).toContainEqual(
			expect.objectContaining({ severity: "error", code: "unknown_entity", ref: "reading 0" })
		)
	})

	test("a supplied entrance is a subject_not_building error", () => {
		expect(validateRecords({ ...EXAMPLE_RECORDS, readings: [readingFor(NORTH)] })).toContainEqual(
			expect.objectContaining({ severity: "error", code: "subject_not_building", ref: "reading 0" })
		)
	})
})
