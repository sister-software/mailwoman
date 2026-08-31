/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Span-value comparison shared by the eval scripts: a unicode-aware fold plus the token-subset match.
 */

/**
 * Lowercase, strip non-alphanumeric (unicode-aware) to single spaces, collapse + trim.
 */
export function norm(s: string): string {
	return s
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replaceAll(/\s+/g, " ")
}

/**
 * Normalized exact, or either-direction TOKEN-subset (fragmentation + decomposition tolerant). Token subset, not raw
 * substring, so "Saint" ⊆ "Saint Paul" and "Ave" ⊆ "Elm Ave" match while "Park" does NOT spuriously match "Parkway".
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
