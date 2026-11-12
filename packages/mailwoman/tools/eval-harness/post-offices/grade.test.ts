// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Grades written parses of one post-office suite row, the Caguas, Puerto Rico post
 *   office from the USGS National Map's 2026-11-09 pull, without running a model.
 */

import { describe, expect, it } from "vitest"

import type { PipelineParse } from "#tools/eval-harness/pipeline-parse/worker"
import {
	gradePostOfficeRow,
	postOfficeSuiteReport,
	summarizePostOfficeGrades,
} from "#tools/eval-harness/post-offices/grade"
import type { PostOfficeSuiteRow } from "#tools/eval-harness/post-offices/rows"

const RAW = "555 Calle Munoz Rivera, Caguas, PR 00725"

const ROW: PostOfficeSuiteRow = {
	raw: RAW,
	span_starts: [0, 4, 24, 32, 35],
	span_ends: [3, 22, 30, 34, 40],
	span_tags: ["house_number", "street", "locality", "region", "postcode"],
	country: "US",
	source: "usgs-national-map",
	source_id: "09da8555-c417-407d-8f43-732d68559157#address",
	group: "09da8555-c417-407d-8f43-732d68559157",
	form: "address",
	provenance: "mapping-agency",
	expected: {
		house_number: "555",
		street: "Calle Munoz Rivera",
		locality: "Caguas",
		region: "PR",
		postcode: "00725",
	},
}

function parse(...spans: Array<[string, number, number]>): Pick<PipelineParse, "spans"> {
	return { spans: spans.map(([tag, start, end]) => [tag, start, end, RAW.slice(start, end)]) }
}

const CORRECT = parse(
	["house_number", 0, 3],
	["street", 4, 22],
	["locality", 24, 30],
	["region", 32, 34],
	["postcode", 35, 40]
)

describe("gradePostOfficeRow", () => {
	it("passes a parse that returns every component at its expected boundaries", () => {
		expect(gradePostOfficeRow(ROW, CORRECT).pass).toBe(true)
	})

	it("passes a parse that splits the street type off, because the street family is joined first", () => {
		const split = parse(
			["house_number", 0, 3],
			["street_prefix", 4, 9],
			["street", 10, 22],
			["locality", 24, 30],
			["region", 32, 34],
			["postcode", 35, 40]
		)

		expect(gradePostOfficeRow(ROW, split).pass).toBe(true)
	})

	it("fails the component a parse gets wrong, and a component the row doesn't expect", () => {
		const wrong = parse(
			["house_number", 0, 3],
			["street", 4, 22],
			["locality", 24, 30],
			["country", 32, 34],
			["postcode", 35, 40]
		)

		const grade = gradePostOfficeRow(ROW, wrong)

		expect(grade.pass).toBe(false)

		expect(grade.components.filter((component) => !component.pass)).toEqual([
			{ tag: "country", expected: [], observed: ["PR"], pass: false },
			{ tag: "region", expected: ["PR"], observed: [], pass: false },
		])
	})
})

describe("postOfficeSuiteReport", () => {
	it("states each count with its denominator and lists the failing input beside expected and observed", () => {
		const grades = [
			gradePostOfficeRow(ROW, CORRECT),
			gradePostOfficeRow(
				ROW,
				parse(["house_number", 0, 3], ["street", 4, 30], ["region", 32, 34], ["postcode", 35, 40])
			),
		]

		expect(summarizePostOfficeGrades(grades)).toMatchObject({ rows: 2, failedRows: 1 })

		expect(postOfficeSuiteReport(grades)).toEqual([
			"post-office suite: 1/2 rows parse as expected, 1 fail",
			"  house_number: 0 of 2 rows differ from the expected value",
			"  locality: 1 of 2 rows differ from the expected value",
			"  postcode: 0 of 2 rows differ from the expected value",
			"  region: 0 of 2 rows differ from the expected value",
			"  street: 1 of 2 rows differ from the expected value",
			`FAIL usgs-national-map:09da8555-c417-407d-8f43-732d68559157#address [US address] "${RAW}"`,
			'  locality: expected ["Caguas"], observed []',
			'  street: expected ["Calle Munoz Rivera"], observed ["Calle Munoz Rivera, Caguas"]',
		])
	})
})
