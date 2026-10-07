/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { renderReport, reportLines } from "@mailwoman/dossier"
import { BUILDING_A, districtDossier } from "@mailwoman/opportunity-map/example-district"
import { describe, expect, test } from "vitest"

import { buildingReportPart, dossierAnchor } from "#evidence"

const dossier = districtDossier()
const lines = reportLines(dossier)

describe("buildingReportPart", () => {
	test("is the text of exactly the building's line records, in the report's order", () => {
		for (const section of dossier.buildings) {
			const { id, label } = section.building
			const own = lines.filter((entry) => entry.building === id)
			const part = buildingReportPart(lines, id)

			expect(own.length).toBeGreaterThan(0)
			expect(part).toBe(own.map((entry) => entry.text).join("\n"))
			expect(part.startsWith(`## ${label}\n`)).toBe(true)
			expect(renderReport(dossier)).toContain(part)
		}
	})

	test("the parts hold every building line once, in order, and no line outside the building sections", () => {
		const parts = dossier.buildings.map((section) => buildingReportPart(lines, section.building.id))
		const buildingLines = lines.filter((entry) => entry.building !== null)

		expect(parts.join("\n")).toBe(buildingLines.map((entry) => entry.text).join("\n"))
		expect(parts.join("\n")).not.toContain("## Sources")
		expect(parts.join("\n")).not.toContain("## Unplaced layer readings")
	})

	test("is empty for a building the report does not hold", () => {
		expect(buildingReportPart(lines, "building:example-z")).toBe("")
	})

	test("holds the provider line of Example Building A", () => {
		expect(buildingReportPart(lines, BUILDING_A)).toContain("Example Fiber Co fiber 1 Gbps: available on 2026-09-30")
	})
})

describe("dossierAnchor", () => {
	test("writes a building identifier as a page anchor", () => {
		expect(dossierAnchor(BUILDING_A)).toBe("dossier-building-example-a")
	})
})
