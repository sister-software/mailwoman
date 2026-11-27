// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { OUTCOME_KINDS } from "#outcome/kinds"
import { currentOutcomeKind, isOutcomeKind, outcomeSatisfies } from "#outcome/satisfy"

describe("outcome kinds", () => {
	it("satisfies a requested id by the member itself or its parent, never a sibling", () => {
		expect(outcomeSatisfies("natural.mountain", "natural")).toBe(true)
		expect(outcomeSatisfies("natural.mountain", "natural.mountain")).toBe(true)
		expect(outcomeSatisfies("natural.mountain", "natural.water")).toBe(false)
		expect(outcomeSatisfies("natural", "natural.mountain")).toBe(false)
	})

	it("admits only vocabulary members", () => {
		expect(isOutcomeKind("landmark")).toBe(true)
		expect(isOutcomeKind("coffee")).toBe(false)
	})

	it("numbers the members 1 to n with no gap, each parent a defined top level", () => {
		const rows = Object.entries(OUTCOME_KINDS)

		expect(rows.map(([, row]) => row.id)).toEqual(rows.map((_, index) => index + 1))

		for (const [name, row] of rows) {
			if (row.parent) {
				expect(OUTCOME_KINDS[row.parent].parent, name).toBeNull()
			}

			expect(currentOutcomeKind(name as keyof typeof OUTCOME_KINDS)).toBe(name)
		}
	})
})
