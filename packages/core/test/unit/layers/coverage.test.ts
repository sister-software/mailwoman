/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { assertAreaAgreement, CoverageBasis, sourcePresentCoverageCells } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

describe("sourcePresentCoverageCells", () => {
	it("emits one sorted source_present row per observed cell and none elsewhere", () => {
		const cells = sourcePresentCoverageCells(
			new Map([
				[30, 2],
				[10, 1],
			])
		)

		expect(cells).toEqual([
			{ h3Cell: 10, completeness: 1, basis: CoverageBasis.SourcePresent, observedRows: 1 },
			{ h3Cell: 30, completeness: 1, basis: CoverageBasis.SourcePresent, observedRows: 2 },
		])
	})
})

describe("assertAreaAgreement", () => {
	const area = { nestedKM2: 90, sourceKM2: 100, allExteriorKM2: 120, relativeGap: 0.1 }

	it("admits a gap within tolerance", () => {
		expect(() => assertAreaAgreement("test build", area, 0.1)).not.toThrow()
	})

	it("refuses a gap past tolerance and names both totals", () => {
		expect(() => assertAreaAgreement("test build", area, 0.05)).toThrow(
			/^test build: the encoded rings total 90\.0 km² against the source's 100\.0 km² \(10\.00% apart, tolerance 5%\)/
		)
	})
})
