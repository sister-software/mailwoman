// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The one reader of an SPDX license expression's terms: a single linear pass over the text.
 *
 *   A regular expression such as `\s+(?:AND|OR)\s+` backtracks polynomially over a long run of
 *   whitespace, and an expression can arrive from a publisher's metadata. Every reader of an
 *   expression in this repository splits it here instead.
 *
 *   The pass reads operators as SPDX does: case-insensitive ASCII `AND`, `OR` and `WITH`, each
 *   with whitespace on both sides. It doesn't build a tree, so grouping is read only as the
 *   parentheses it removes.
 */

/**
 * The operators of an SPDX license expression.
 */
export const ExpressionOperator = {
	And: "AND",
	Or: "OR",
	With: "WITH",
} as const

/**
 * One of the {@link ExpressionOperator} values.
 */
export type ExpressionOperator = (typeof ExpressionOperator)[keyof typeof ExpressionOperator]

/**
 * Whether one UTF-16 code unit is whitespace, as a regular expression's `\s` reads it.
 */
function isWhitespace(text: string, index: number): boolean {
	const code = text.charCodeAt(index)

	if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true

	if (code < 0x80) return false

	return (
		code === 0xa0 ||
		code === 0x16_80 ||
		(code >= 0x20_00 && code <= 0x20_0a) ||
		code === 0x20_28 ||
		code === 0x20_29 ||
		code === 0x20_2f ||
		code === 0x20_5f ||
		code === 0x30_00 ||
		code === 0xfe_ff
	)
}

/**
 * Whether `operator` is spelled at `index`, matching ASCII letters without regard to case.
 */
function spellsOperator(text: string, index: number, operator: ExpressionOperator): boolean {
	if (index + operator.length > text.length) return false

	for (let offset = 0; offset < operator.length; offset++) {
		const upper = operator.charCodeAt(offset)
		const code = text.charCodeAt(index + offset)

		if (code !== upper && code !== upper + 0x20) return false
	}

	return true
}

/**
 * Splits `text` at each of `operators` that has whitespace on both sides, and returns the pieces untrimmed.
 *
 * A separator is the whole whitespace run before the operator, the operator, and the whole run after it.
 * The scan resumes after a separator, so `A AND OR B` splits once, into `A` and `OR B`.
 */
export function splitAtOperators(text: string, operators: readonly ExpressionOperator[]): string[] {
	const pieces: string[] = []
	let pieceStart = 0
	let index = 0

	while (index < text.length) {
		if (!isWhitespace(text, index)) {
			index += 1

			continue
		}

		let runEnd = index

		while (runEnd < text.length && isWhitespace(text, runEnd)) {
			runEnd += 1
		}

		const operator = operators.find(
			(candidate) =>
				spellsOperator(text, runEnd, candidate) &&
				runEnd + candidate.length < text.length &&
				isWhitespace(text, runEnd + candidate.length)
		)

		if (!operator) {
			index = runEnd

			continue
		}

		let separatorEnd = runEnd + operator.length

		while (separatorEnd < text.length && isWhitespace(text, separatorEnd)) {
			separatorEnd += 1
		}

		pieces.push(text.slice(pieceStart, index))
		pieceStart = separatorEnd
		index = separatorEnd
	}

	pieces.push(text.slice(pieceStart))

	return pieces
}

/**
 * The terms of an expression between `operators`, with parentheses removed,
 * trimmed, and empty terms dropped.
 *
 * `licenseExpressionTerms("(MIT OR Apache-2.0) AND CC0-1.0", [And, Or])` returns the three identifiers.
 */
export function licenseExpressionTerms(expression: string, operators: readonly ExpressionOperator[]): string[] {
	let ungrouped = ""

	for (const character of expression) {
		ungrouped += character === "(" || character === ")" ? " " : character
	}

	return splitAtOperators(ungrouped, operators)
		.map((part) => part.trim())
		.filter((part) => part.length)
}

/**
 * The license part of one identifier, without any `WITH` exception.
 */
export function licenseWithoutException(identifier: string): string {
	return splitAtOperators(identifier, [ExpressionOperator.With])[0]!
}
