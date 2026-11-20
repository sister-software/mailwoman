// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, it } from "vitest"

import { apportion } from "./tuples.ts"

it("divides a deficit in proportion to population, and its parts sum to the deficit", () => {
	const parts = apportion(10, [8_000_000, 1_000_000, 1_000_000])

	expect(parts.reduce((a, b) => a + b, 0)).toBe(10)
	expect(parts).toEqual([8, 1, 1])
	expect(apportion(7, [3, 3, 3]).reduce((a, b) => a + b, 0)).toBe(7)
})

it("divides evenly where no place records a population", () => {
	expect(apportion(4, [0, 0])).toEqual([2, 2])
	expect(apportion(3, [])).toEqual([])
})
