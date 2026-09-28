/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Jaro-Winkler is the default record-linkage comparator for names. {@link nameSimilarity} adds
 *   the literature's token/edit fallback because J-W scores a compound surname's second half near zero.
 */

import { distance as levenshteinDistance } from "fastest-levenshtein"

/**
 * Jaro similarity in [0, 1], where two empty strings are identical (1) and one empty is 0.
 */
export function jaro(a: string, b: string): number {
	if (a === b) return 1
	const la = a.length
	const lb = b.length

	if (la === 0 || lb === 0) return 0

	const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1)
	const aMatched = new Array<boolean>(la).fill(false)
	const bMatched = new Array<boolean>(lb).fill(false)

	let matches = 0

	for (let i = 0; i < la; i++) {
		const start = Math.max(0, i - window)
		const end = Math.min(i + window + 1, lb)

		for (let j = start; j < end; j++) {
			if (bMatched[j] || a[i] !== b[j]) continue
			aMatched[i] = true
			bMatched[j] = true

			matches++

			break
		}
	}

	if (matches === 0) return 0

	let transpositions = 0
	let k = 0

	for (let i = 0; i < la; i++) {
		if (!aMatched[i]) continue

		while (!bMatched[k]) {
			k++
		}

		if (a[i] !== b[k]) {
			transpositions++
		}

		k++
	}

	transpositions /= 2

	return (matches / la + matches / lb + (matches - transpositions) / matches) / 3
}

/**
 * Jaro-Winkler similarity in [0, 1]: Jaro plus a shared-prefix bonus, boosting only when Jaro
 * already clears the 0.7 threshold, with Winkler's standard prefix cap 4 and weight 0.1.
 */
export function jaroWinkler(
	a: string,
	b: string,
	opts: { weight?: number; maxPrefix?: number; boostThreshold?: number } = {}
): number {
	const weight = opts.weight ?? 0.1
	const maxPrefix = opts.maxPrefix ?? 4
	const boostThreshold = opts.boostThreshold ?? 0.7

	const base = jaro(a, b)

	if (base < boostThreshold) return base

	let prefix = 0
	const limit = Math.min(maxPrefix, a.length, b.length)

	while (prefix < limit && a[prefix] === b[prefix]) {
		prefix++
	}

	return base + prefix * weight * (1 - base)
}

/**
 * Jaccard similarity `|a ∩ b| / |a ∪ b|` over two token sets, where an empty side scores 0 rather than 1
 * because treating no evidence as perfect agreement floods a blocking pass with false pairs.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (!a.size || !b.size) return 0
	let intersection = 0

	for (const token of a) {
		if (b.has(token)) {
			intersection++
		}
	}

	return intersection / (a.size + b.size - intersection)
}

/**
 * Normalized Levenshtein similarity in [0, 1]: `1 - editDistance / max(len)`.
 */
export function levenshteinSimilarity(a: string, b: string): number {
	if (a === b) return 1
	const longest = Math.max(a.length, b.length)

	if (longest === 0) return 1

	return 1 - levenshteinDistance(a, b) / longest
}

/**
 * Name-aware similarity in [0, 1] that floors the score at 0.9 when one name's
 * tokens are a strict subset of the other's.
 *
 * In other cases, it returns the better of Jaro-Winkler and normalized edit
 * similarity without case or whitespace sensitivity.
 */
export function nameSimilarity(a: string, b: string): number {
	const x = a.trim().toLowerCase().replaceAll(/\s+/g, " ")
	const y = b.trim().toLowerCase().replaceAll(/\s+/g, " ")

	if (!x || !y) return 0

	if (x === y) return 1

	const jw = jaroWinkler(x, y)

	const xTokens = new Set(x.split(" "))
	const yTokens = new Set(y.split(" "))
	const [small, big] = xTokens.size <= yTokens.size ? [xTokens, yTokens] : [yTokens, xTokens]
	const subset = small.size < big.size && [...small].every((t) => big.has(t))

	if (subset) return Math.max(jw, 0.9)

	return Math.max(jw, levenshteinSimilarity(x, y))
}
