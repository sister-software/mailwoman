/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { buildDossier, renderReport } from "@mailwoman/dossier"
import { BUILDING_A, DISTRICT_RECORDS, DISTRICT_SCENARIO } from "@mailwoman/opportunity-map/example-district"
import { describe, expect, test } from "vitest"

import { dossierAnchor, dossierReportParts } from "#evidence"

const dossier = buildDossier(DISTRICT_RECORDS, { asOf: DISTRICT_SCENARIO.asOf })
const report = renderReport(dossier)
const buildings = dossier.buildings.map((section) => section.building)

describe("dossierReportParts", () => {
	test("returns each building's part of the report, from its heading to the next level-two heading", () => {
		const parts = dossierReportParts(report, buildings)

		expect([...parts.keys()]).toEqual(buildings.map((building) => building.id))

		for (const building of buildings) {
			const part = parts.get(building.id)!

			expect(part.startsWith(`## ${building.label}\n`)).toBe(true)
			expect(part).not.toContain("\n## ")
			expect(report).toContain(part)
		}

		expect(parts.get(BUILDING_A)).toContain("Example Fiber Co fiber 1 Gbps: available on 2026-09-30")
	})

	test("throws for a label that heads no part", () => {
		expect(() => dossierReportParts(report, [{ id: BUILDING_A, label: "Example Building Z" }])).toThrow(
			'the dossier report has no part headed "## Example Building Z"'
		)
	})

	test("throws for a label that heads two parts", () => {
		const twice = `${report}\n## Example Building A\n\nA second part.\n`

		expect(() => dossierReportParts(twice, [{ id: BUILDING_A, label: "Example Building A" }])).toThrow(
			/heads two parts/
		)
	})
})

describe("dossierAnchor", () => {
	test("writes a building identifier as a page anchor", () => {
		expect(dossierAnchor(BUILDING_A)).toBe("dossier-building-example-a")
	})
})
