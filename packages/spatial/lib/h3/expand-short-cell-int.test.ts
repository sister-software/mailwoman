// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { latLngToCell } from "@sister.software/h3"
import { describe, expect, it } from "vitest"

import { expandShortCellInt, shortCellToInt } from "#h3/cell"

describe("expandShortCellInt", () => {
	it("inverts shortCellToInt at the stored resolution", () => {
		const cell = latLngToCell(51.5074, -0.1278, 9)

		expect(expandShortCellInt(shortCellToInt(cell), 9)).toBe(cell)
	})

	it("refuses an integer that names no cell at the stated resolution", () => {
		expect(() => expandShortCellInt(1, 9)).toThrow(/does not name a valid cell at resolution 9/)
	})
})
