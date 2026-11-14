// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A case-insensitive lookup over one subtag table, including its private-use ranges.
 *
 *   The registry states a private-use block as one range record, such as `qaa..qtz` or `QM..QZ`.
 *   A subtag inside a range answers that range's record.
 */

import type { SubtagRow } from "#types"

/**
 * A lookup from a subtag in any case to its registry row.
 */
export interface SubtagIndex {
	get(subtag: string): SubtagRow | null
}

/**
 * Builds the lookup for one table's rows.
 */
export function indexSubtagRows(rows: readonly SubtagRow[]): SubtagIndex {
	const exact = new Map<string, SubtagRow>()
	const ranges: Array<{ low: string; high: string; row: SubtagRow }> = []

	for (const row of rows) {
		const key = row.subtag.toLowerCase()
		const dots = key.indexOf("..")

		if (dots === -1) {
			exact.set(key, row)
		} else {
			ranges.push({ low: key.slice(0, dots), high: key.slice(dots + 2), row })
		}
	}

	return {
		get(subtag) {
			const key = subtag.toLowerCase()
			const found = exact.get(key)

			if (found) return found

			for (const range of ranges) {
				if (key.length === range.low.length && key >= range.low && key <= range.high) return range.row
			}

			return null
		},
	}
}

/**
 * Returns a lookup built on its first call from `rows()`, then shared.
 */
export function lazySubtagIndex(rows: () => readonly SubtagRow[]): () => SubtagIndex {
	let index: SubtagIndex | null = null

	return () => {
		index ??= indexSubtagRows(rows())

		return index
	}
}
