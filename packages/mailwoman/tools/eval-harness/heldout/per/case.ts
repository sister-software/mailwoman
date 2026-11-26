// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Held-out rows rewritten in the case a person types, so the scorer can grade a model on lowercase input.
 *
 *   A row's gold spans are code-unit offsets into its `raw` text.
 *   The lowercase text keeps them valid only when it keeps the text's length.
 *
 *   `İ` lowercases to two code units, for example.
 *   A row whose lowercase text has another length is left out and counted, so the caller can report it.
 */

/**
 * A row's text and identity, as far as the case transform reads it.
 */
interface CasedRow {
	raw: string
}

/**
 * The register the scorer reads rows in.
 */
export const HeldoutCase = {
	AsWritten: "as-written",
	Lower: "lower",
} as const

export type HeldoutCase = (typeof HeldoutCase)[keyof typeof HeldoutCase]

/**
 * `rows` in the register `register`, and the number of rows left out
 * because lowercasing changed their length.
 *
 * Every other field of a row, its spans included, is kept as it was.
 */
export function rowsInCase<T extends CasedRow>(
	rows: readonly T[],
	register: HeldoutCase
): { rows: T[]; leftOut: number } {
	if (register === HeldoutCase.AsWritten) {
		return { rows: [...rows], leftOut: 0 }
	}

	const kept: T[] = []
	let leftOut = 0

	for (const row of rows) {
		const lower = row.raw.toLowerCase()

		if (lower.length !== row.raw.length) {
			leftOut++

			continue
		}

		kept.push({ ...row, raw: lower })
	}

	return { rows: kept, leftOut }
}
