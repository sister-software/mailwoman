// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { HeldoutCase, rowsInCase } from "./case.ts"

describe("rowsInCase", () => {
	it("lowercases each row's text and keeps its spans, and leaves out a row whose length changes", () => {
		const rows = [
			{ raw: "10 Downing Street, London SW1A 2AA", span_starts: [0, 3], span_ends: [2, 17] },
			{ raw: "İstiklal Caddesi 1, İstanbul", span_starts: [0], span_ends: [16] },
		]

		const { rows: lower, leftOut } = rowsInCase(rows, HeldoutCase.Lower)

		expect(lower).toEqual([{ raw: "10 downing street, london sw1a 2aa", span_starts: [0, 3], span_ends: [2, 17] }])
		expect(leftOut).toBe(1)
	})

	it("keeps every row as written in the as-written register", () => {
		const rows = [{ raw: "İstanbul" }]

		expect(rowsInCase(rows, HeldoutCase.AsWritten)).toEqual({ rows, leftOut: 0 })
	})
})
