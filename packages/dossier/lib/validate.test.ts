/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import type { LayerReading } from "#coverage"
import { ExplanationKind } from "#explanations"
import type { EntityID } from "#identifiers"
import {
	ACCESS_DISPOSITION,
	ANNEX,
	CABLE_CHECK,
	EMPTY_RECORDS,
	EXAMPLE_RECORDS,
	HOUSE,
	NORTH,
	UNSTATED_IDENTIFIER_RECORDS,
} from "#test/fixtures/example-house"
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

describe("validateRecords: external identifiers", () => {
	test("the example records' identifiers each cite the permit and raise no identifier issue", () => {
		expect(validateRecords(EXAMPLE_RECORDS).filter((issue) => / identifier \d+$/.test(issue.ref ?? ""))).toEqual([])
	})

	test("an identifier without evidence is an identifier_without_evidence warning", () => {
		expect(
			validateRecords(UNSTATED_IDENTIFIER_RECORDS)
				.filter((issue) => issue.code === "identifier_without_evidence")
				.map((issue) => [issue.severity, issue.ref, issue.message])
		).toEqual([
			[
				"warning",
				"parcel:example-parcel identifier 0",
				"parcel:example-parcel identifier 0 (example:lot 12-34) has no evidence, so the report prints it with the words source unstated",
			],
			[
				"warning",
				"building:example-house identifier 0",
				"building:example-house identifier 0 (example:bin 1001) has no evidence, so the report prints it with the words source unstated",
			],
			[
				"warning",
				"building:example-annex identifier 0",
				"building:example-annex identifier 0 (example:bin 1002) has no evidence, so the report prints it with the words source unstated",
			],
		])
	})

	test("an identifier whose evidence cites a supplied source raises no issue, and one citing an unsupplied source is an error", () => {
		const issues = validateRecords({
			...EXAMPLE_RECORDS,
			entities: EXAMPLE_RECORDS.entities.map((entity) =>
				entity.id === HOUSE
					? { ...entity, externalIDs: [{ ...entity.externalIDs[0]!, evidence: { source: "permit-2021" } }] }
					: entity.id === ANNEX
						? { ...entity, externalIDs: [{ ...entity.externalIDs[0]!, evidence: { source: "no-such-permit" } }] }
						: entity
			),
		})

		expect(
			issues
				.filter((issue) => issue.ref?.startsWith(HOUSE) || issue.ref?.startsWith(ANNEX))
				.map((issue) => [issue.severity, issue.code, issue.ref])
		).toEqual([["error", "unknown_source", "building:example-annex identifier 0"]])
	})
})

describe("validateRecords: the claims a claim derives from", () => {
	test("the example records' inferred claim derives from a supplied claim", () => {
		expect(validateRecords(EXAMPLE_RECORDS).map((issue) => issue.code)).not.toContain("unknown_claim")
	})

	test("a derived or inferred claim that names an identifier no supplied claim has is an unknown_claim error", () => {
		const issues = validateRecords({
			...EXAMPLE_RECORDS,
			claims: [
				...EXAMPLE_RECORDS.claims,
				{
					id: "c3",
					subject: HOUSE,
					axis: "engineering",
					predicate: "riser_route_length_m",
					value: 40,
					status: "derived",
					derivedFrom: ["c1", "c9"],
					evidence: { source: "survey-2022" },
				},
				{
					id: "c4",
					subject: HOUSE,
					axis: "engineering",
					predicate: "riser_route",
					value: "unknown",
					status: "inferred",
					derivedFrom: ["c8"],
					explanation: "A riser shown on a plan may not reach the roof.",
					evidence: { source: "survey-2022" },
				},
			],
		})

		expect(
			issues.filter((issue) => issue.severity === "error").map((issue) => [issue.code, issue.ref, issue.message])
		).toEqual([
			["unknown_claim", "c3", "c3 derives from claim c9, which is not supplied"],
			["unknown_claim", "c4", "c4 derives from claim c8, which is not supplied"],
		])
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

describe("validateRecords: memberships and positions", () => {
	test("a membership must cite a supplied source and place a supplied building", () => {
		const issues = validateRecords({
			...EXAMPLE_RECORDS,
			memberships: [
				{ subject: HOUSE, extent: "cell-1", evidence: { source: "no-such-survey" } },
				{ subject: NORTH, extent: "cell-1", evidence: { source: "survey-2022" } },
				{ subject: "building:ghost", extent: "cell-1", evidence: { source: "survey-2022" } },
			],
		})

		expect(issues.filter((issue) => issue.severity === "error").map((issue) => [issue.code, issue.ref])).toEqual([
			["unknown_source", "membership 0"],
			["subject_not_building", "membership 1"],
			["unknown_entity", "membership 2"],
		])
	})

	test("a position must locate a supplied building inside the range of latitude and longitude", () => {
		const position = {
			subject: HOUSE,
			latitude: 40.1,
			longitude: -73.9,
			synthetic: true,
			evidence: { source: "survey-2022" },
		}

		const issues = validateRecords({
			...EXAMPLE_RECORDS,
			positions: [
				position,
				{ ...position, subject: NORTH },
				{ ...position, latitude: -90.5 },
				{ ...position, longitude: 180.5 },
				{ ...position, latitude: Number.NaN },
			],
		})

		expect(issues.filter((issue) => issue.severity === "error").map((issue) => [issue.code, issue.ref])).toEqual([
			["subject_not_building", "position 1"],
			["position_out_of_range", "position 2"],
			["position_out_of_range", "position 3"],
			["position_out_of_range", "position 4"],
		])
	})
})

describe("validateRecords: availability checks and the records that explain them", () => {
	test("a check's subject must be a supplied building, and a check id appears once", () => {
		const issues = validateRecords({
			...EXAMPLE_RECORDS,
			checks: [
				CABLE_CHECK,
				{ ...CABLE_CHECK, subject: NORTH },
				{ ...CABLE_CHECK, id: "ghost", subject: "building:ghost" },
			],
		})

		expect(issues).toContainEqual(
			expect.objectContaining({ severity: "error", code: "duplicate_check", ref: "house-cable" })
		)

		expect(issues).toContainEqual(
			expect.objectContaining({ severity: "error", code: "subject_not_building", ref: "house-cable" })
		)

		expect(issues).toContainEqual(expect.objectContaining({ severity: "error", code: "unknown_entity", ref: "ghost" }))
	})

	test("a probability must name a supplied check, lie between 0 and 1, and state its basis", () => {
		const probability = {
			check: CABLE_CHECK.id,
			kind: ExplanationKind.Route,
			probability: 0.4,
			basis: "held in 4 of 10 comparable exceptions",
			evidence: { source: "survey-2022" },
		}

		const issues = validateRecords({
			...EXAMPLE_RECORDS,
			probabilities: [
				probability,
				{ ...probability, check: "no-such-check" },
				{ ...probability, probability: 1.5 },
				{ ...probability, basis: " " },
			],
		})

		expect(issues.filter((issue) => issue.severity === "error").map((issue) => [issue.code, issue.ref])).toEqual([
			["unknown_check", "probability 1"],
			["probability_out_of_range", "probability 2"],
			["probability_without_basis", "probability 3"],
		])
	})

	test("a disposition must name a supplied check and cite supplied records with well-formed dates and durations", () => {
		const issues = validateRecords({
			...EXAMPLE_RECORDS,
			dispositions: [
				{ ...ACCESS_DISPOSITION, id: "x1", check: "no-such-check" },
				{ ...ACCESS_DISPOSITION, id: "x2", decidedAt: "06/01/2022" },
				{
					...ACCESS_DISPOSITION,
					id: "x3",
					outcome: { ...ACCESS_DISPOSITION.outcome!, minutesSpent: -5, evidence: { source: "no-such-log" } },
				},
			],
		})

		expect(issues.filter((issue) => issue.severity === "error").map((issue) => [issue.code, issue.ref])).toEqual([
			["unknown_check", "x1"],
			["malformed_date", "x2"],
			["unknown_source", "x3"],
			["negative_duration", "x3"],
		])
	})

	test("a blocker observation must cite a supplied source and entity", () => {
		const issues = validateRecords({
			...EXAMPLE_RECORDS,
			blockers: [
				{
					id: "b1",
					subject: "building:ghost",
					kind: ExplanationKind.Capacity,
					applies: true,
					statement: "Cabinet C-1 has no spare ports",
					evidence: { source: "no-such-survey" },
				},
			],
		})

		expect(issues.filter((issue) => issue.severity === "error").map((issue) => [issue.code, issue.ref])).toEqual([
			["unknown_source", "b1"],
			["unknown_entity", "b1"],
		])
	})
})
