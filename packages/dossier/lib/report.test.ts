/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { buildDossier } from "#dossier"
import { renderReport } from "#report"
import { EXAMPLE_RECORDS } from "#test/fixtures/example-house"

describe("renderReport", () => {
	const report = renderReport(buildDossier(EXAMPLE_RECORDS, { asOf: "2022-06-30" }))

	test("states the cutoff and the admitted, excluded and undated records", () => {
		expect(report).toContain("as of 2022-06-30")
		expect(report).toContain("manager-2023")
		expect(report).toMatch(/undated.*undated-listing/i)
	})

	test("shows each building's counts by stage, with unresolved totals worded as unresolved", () => {
		expect(report).toMatch(/Example House/)
		expect(report).toMatch(/completed.*20/)
		expect(report).toMatch(/occupied.*unresolved/)
	})

	test("words a source-present empty reading as unknown absence", () => {
		expect(report).toMatch(/looked and found no record; absence is unknown/)
	})

	test("lists each unresolved question with the record that would resolve it", () => {
		expect(report).toMatch(/signing authority[\s\S]*would resolve/)
	})
})
