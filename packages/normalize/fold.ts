/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Match-key folds: the loss-y transforms a comparison applies to both sides.
 */

/**
 * Lower-case, whitespace runs collapsed to one space, ends trimmed. The fold every string comparison applies before it
 * compares; it keeps punctuation and diacritics, so `Saint-Étienne` and `Saint-Etienne` stay distinct.
 */
export function foldCaseWhitespace(input: string): string {
	return input.toLowerCase().replaceAll(/\s+/gu, " ").trim()
}

/**
 * Combining marks removed after NFD decomposition: `é` → `e`, `ł` unchanged (it is not a base plus a mark). Case and
 * whitespace are untouched.
 */
export function stripCombiningMarks(input: string): string {
	return input.normalize("NFD").replaceAll(/\p{M}/gu, "")
}
