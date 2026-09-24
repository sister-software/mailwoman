/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Shared Unicode-aware normalization and token-subset matching for evaluation scripts.
 */

/**
 * Lowercase, replace non-alphanumeric runs with spaces, and collapse whitespace.
 */
export function norm(s: string): string {
	return s
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replaceAll(/\s+/g, " ")
}

/**
 * Lowercase and trim while preserving punctuation and interior whitespace.
 */
export function normLoose(s: string | undefined): string {
	return (s ?? "").toLowerCase().trim()
}

/**
 * Match normalized equality or token-subset in either direction.
 */
export function valueMatch(pred: string, gold: string): boolean {
	const a = norm(pred)
	const b = norm(gold)

	if (!a || !b) return false

	if (a === b) return true
	const at = a.split(" ")
	const bt = b.split(" ")
	const aset = new Set(at)
	const bset = new Set(bt)
	const subset = (xs: string[], ys: Set<string>): boolean => xs.every((t) => ys.has(t))

	return subset(at, bset) || subset(bt, aset)
}
