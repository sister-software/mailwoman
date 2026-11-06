/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The small error vocabulary a strict parse answers with.
 *
 *   The four reasons are distinct so a caller can tell a misspelling from an absence. `shape` is the wrong length or
 *   alphabet. `case` is the right letters in the wrong case. `not-found-in-snapshot` is a canonical spelling the profile
 *   holds no record for. `status-excluded` is a code the profile holds under a status the strict brand leaves out. The
 *   messages name no record, so a membership-only import pulls in no name dictionary.
 */

/**
 * The reason a strict parse refused its input.
 */
export const ParseFailure = {
	Shape: "shape",
	Case: "case",
	NotFound: "not-found-in-snapshot",
	StatusExcluded: "status-excluded",
} as const

export type ParseFailure = (typeof ParseFailure)[keyof typeof ParseFailure]

/**
 * A structured parse result: the branded value, or why the input was refused.
 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: ParseFailure; input: string }

/**
 * Reports which refusal a fixed-length grammar gives an input, or `null` when the shape passes.
 */
export function shapeFailure(input: string, length: number, uppercaseLetters: boolean): ParseFailure | null {
	if (input.length !== length) return ParseFailure.Shape

	if (uppercaseLetters) {
		if (/^[A-Z]+$/.test(input)) return null

		return /^[A-Za-z]+$/.test(input) ? ParseFailure.Case : ParseFailure.Shape
	}

	return /^[0-9]+$/.test(input) ? null : ParseFailure.Shape
}
