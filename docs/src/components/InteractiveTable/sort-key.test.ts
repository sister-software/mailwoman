// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { compareSortKeys, isNumericColumn, sortKeyOf } from "./sort-key"

describe("sortKeyOf", () => {
	it("reads the coverage table's cells", () => {
		expect(sortKeyOf("487,703,147 rows")).toEqual({ kind: "number", value: 487_703_147 })
		expect(sortKeyOf("20,523 rows, declined")).toEqual({ kind: "number", value: 20_523 })
		expect(sortKeyOf("204/233")).toEqual({ kind: "number", value: 204 / 233 })
		expect(sortKeyOf("-2.5 %")).toEqual({ kind: "number", value: -2.5 })
		expect(sortKeyOf("declined")).toEqual({ kind: "text", value: "declined" })
		expect(sortKeyOf("—")).toEqual({ kind: "blank" })
		expect(sortKeyOf("  ")).toEqual({ kind: "blank" })
	})
})

describe("isNumericColumn", () => {
	it("sorts by number when more than half of the filled cells are numbers", () => {
		const keys = ["1,568,989", "rooftop", "412,432", "—"].map(sortKeyOf)

		expect(isNumericColumn(keys)).toBe(true)
		expect(isNumericColumn(["US", "FR", "12"].map(sortKeyOf))).toBe(false)
		expect(isNumericColumn(["—", ""].map(sortKeyOf))).toBe(false)
	})
})

describe("compareSortKeys", () => {
	it("orders numbers by value, then text after the numbers in a numeric column", () => {
		const cells = ["412,432", "rooftop", "1,568,989", "absent"]
		const keys = cells.map(sortKeyOf) as Array<Exclude<ReturnType<typeof sortKeyOf>, { kind: "blank" }>>

		const order = keys
			.map((key, index) => ({ key, cell: cells[index] }))
			.toSorted((a, b) => compareSortKeys(a.key, b.key, true))
			.map((entry) => entry.cell)

		expect(order).toEqual(["412,432", "1,568,989", "absent", "rooftop"])
	})
})
