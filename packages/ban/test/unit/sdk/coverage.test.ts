/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The coverage basis is the commune's own total, never a share: one uncertified point in a commune keeps every
 *   cell that commune touches at `source_present`, and a cell is `designated` only when every point in it belongs to a
 *   commune the register declared whole.
 */

import { certifiedCoverageCells, wholeCommunes } from "@mailwoman/ban/sdk/coverage"
import { CoverageBasis } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

describe("wholeCommunes", () => {
	it("declares whole only a commune whose minimum flag is 1", () => {
		const whole = wholeCommunes(
			new Map([
				["01001", 1],
				["01002", 0],
				["01003", null],
			])
		)

		expect([...whole]).toEqual(["01001"])
	})
})

describe("certifiedCoverageCells", () => {
	// Two points ~30 m apart share a res-9 cell; the third is a different town.
	const bourg = { lat: 46.2052, lon: 5.2255 }
	const nearBourg = { lat: 46.2054, lon: 5.2257 }
	const oyonnax = { lat: 46.2567, lon: 5.6553 }

	it("marks a cell designated when every point in it belongs to a whole commune", () => {
		const cells = certifiedCoverageCells(
			[
				{ ...bourg, adminCode: "01053" },
				{ ...nearBourg, adminCode: "01053" },
			],
			new Set(["01053"])
		)

		expect(cells).toHaveLength(1)
		expect(cells[0]!.basis).toBe(CoverageBasis.Designated)
		expect(cells[0]!.observedRows).toBe(2)
	})

	it("drops a cell to source_present on one point from a partial or unflagged commune", () => {
		const cells = certifiedCoverageCells(
			[
				{ ...bourg, adminCode: "01053" },
				{ ...nearBourg, adminCode: null },
				{ ...oyonnax, adminCode: "01283" },
			],
			new Set(["01053"])
		)

		const byBasis = Object.fromEntries(cells.map((cell) => [cell.observedRows, cell.basis]))

		expect(cells).toHaveLength(2)
		expect(byBasis[2]).toBe(CoverageBasis.SourcePresent)
		expect(byBasis[1]).toBe(CoverageBasis.SourcePresent)
	})
})
