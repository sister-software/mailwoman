// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Explicit input normalization, separate from the strict predicates.
 *
 *   `canonicalSpelling` trims ASCII whitespace and upper-cases ASCII letters.
 *   It reports each change.
 *
 *   A caller who wants `" aus "` to reach `AUS` asks for that step.
 *   Every other character stays as written.
 *
 *   A dot, a dash or a non-ASCII letter reaches the strict predicate unchanged
 *   and is refused there with `shape`.
 *   Free-text tokenization belongs to Mailwoman, outside this package.
 */

/**
 * What {@link canonicalSpelling} changed.
 */
export interface Normalization {
	value: string
	trimmed: boolean
	uppercased: boolean
}

/**
 * Trims ASCII whitespace and upper-cases ASCII letters, reporting each change.
 */
export function canonicalSpelling(input: string): Normalization {
	const trimmedValue = input.replaceAll(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")
	const value = trimmedValue.replaceAll(/[a-z]+/g, (run) => run.toUpperCase())

	return { value, trimmed: trimmedValue !== input, uppercased: value !== trimmedValue }
}
