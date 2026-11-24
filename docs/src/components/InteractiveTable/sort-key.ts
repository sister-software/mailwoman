// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The sort key of a markdown table cell, read from its rendered text.
 *
 *   A cell is numeric when its text starts with a number: `487,703,147 rows`,
 *   `-2.5 %`, `20,523 rows, declined`.
 *   A fraction such as a board's `204/233` reads as its quotient.
 *   A placeholder (`—`, `-`, an empty cell) is blank.
 */

/**
 * The placeholders a generated table writes for a missing value.
 */
const BLANK = /^(?:—|–|-|n\/a)?$/i

const LEADING_NUMBER = /^([+-]?\d[\d,]*(?:\.\d+)?)(?:\s*\/\s*(\d[\d,]*(?:\.\d+)?))?/

export type SortKey = { kind: "number"; value: number } | { kind: "text"; value: string } | { kind: "blank" }

/**
 * Reads one cell's text into its sort key.
 */
export function sortKeyOf(text: string): SortKey {
	const trimmed = text.trim()

	if (BLANK.test(trimmed)) return { kind: "blank" }

	const match = LEADING_NUMBER.exec(trimmed)

	if (match) {
		const numerator = Number(match[1]!.replaceAll(",", ""))
		const denominator = match[2] ? Number(match[2].replaceAll(",", "")) : null

		return { kind: "number", value: denominator ? numerator / denominator : numerator }
	}

	return { kind: "text", value: trimmed }
}

/**
 * Whether a column sorts by number: more than half of its non-blank cells start with a number.
 *
 * The column's other cells then sort after its numbers, by text.
 */
export function isNumericColumn(keys: readonly SortKey[]): boolean {
	const filled = keys.filter((key) => key.kind !== "blank")

	return filled.length > 0 && filled.filter((key) => key.kind === "number").length * 2 > filled.length
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * Compares two non-blank keys in ascending order.
 * In a numeric column, numbers sort before text.
 *
 * The table hands a blank cell to TanStack as `undefined` with `sortUndefined: "last"`,
 * which keeps blanks last in both directions, so this function never sees one.
 */
export function compareSortKeys(a: Exclude<SortKey, { kind: "blank" }>, b: typeof a, numeric: boolean): number {
	if (numeric && a.kind !== b.kind) return a.kind === "number" ? -1 : 1

	if (a.kind === "number" && b.kind === "number") return a.value - b.value

	return collator.compare(String(a.value), String(b.value))
}
