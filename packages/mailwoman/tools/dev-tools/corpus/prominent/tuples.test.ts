// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, it } from "vitest"

import { apportionUnderCap } from "./tuples.ts"

it("gives no place more than the smallest equal share of a deficit, and the parts sum to the deficit", () => {
	const weights = [8_000_000, 1_000_000, 1_000_000, 500]
	const parts = apportionUnderCap(10, weights)

	expect(parts.reduce((a, b) => a + b, 0)).toBe(10)
	expect(Math.max(...parts)).toBe(Math.ceil(10 / weights.length))
	// The remainder goes to the most populous places.
	expect(parts).toEqual([3, 3, 2, 2])
})

it("divides a deficit smaller than the place count among the most populous places", () => {
	expect(apportionUnderCap(2, [5, 50, 0, 50])).toEqual([0, 1, 0, 1])
	expect(apportionUnderCap(3, [])).toEqual([])
})
