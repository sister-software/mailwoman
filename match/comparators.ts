/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   String comparators for the matcher's scoring stage.
 *
 *   The record-linkage literature (Winkler/Census; Belin 1993) settles on the prefix-weighted Jaro
 *   comparator (Jaro-Winkler) as the default for names: it tolerates the typographical error real
 *   data is full of better than raw character-edit distance. But J-W has a documented blind spot on
 *   compound / double surnames (e.g. Hispanic `Garcia Lopez`): the second half of the compound
 *   falls outside J-W's match window, so `Lopez` vs `Garcia Lopez` scores ~0. The fix the
 *   literature prescribes is an edit-distance / token fallback for single-vs-compound pairs —
 *   implemented in {@link nameSimilarity}.
 *
 *   These are pure similarity primitives in [0, 1]. The mapping of a similarity onto discrete
 *   Fellegi-Sunter agreement levels (and the m/u weights) is the scorer's job, not theirs.
 */

import { distance as levenshteinDistance } from "fastest-levenshtein"

/**
 * Jaro similarity in [0, 1]. Two empty strings are identical (1); one empty is 0. Counts matching characters within a
 * sliding window of `floor(max(len)/2) - 1`, discounting half-transpositions.
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

	// Count transpositions: matched chars of `a` and `b`, in order, that disagree (halved).
	let transpositions = 0
	let k = 0

	for (let i = 0; i < la; i++) {
		if (!aMatched[i]) continue

		while (!bMatched[k]) k++

		if (a[i] !== b[k]) transpositions++
		k++
	}
	transpositions /= 2

	return (matches / la + matches / lb + (matches - transpositions) / matches) / 3
}

/**
 * Jaro-Winkler similarity in [0, 1]: Jaro with a bonus for a shared prefix — `jw = jaro + prefix * weight * (1 -
 * jaro)`, prefix capped at `maxPrefix` (Winkler's standard 4), `weight` the scaling factor (standard 0.1). Only boosts
 * when `jaro` already clears `boostThreshold` (0.7), per Winkler.
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

	while (prefix < limit && a[prefix] === b[prefix]) prefix++

	return base + prefix * weight * (1 - base)
}

/** Normalized Levenshtein similarity in [0, 1]: `1 - editDistance / max(len)`. */
export function levenshteinSimilarity(a: string, b: string): number {
	if (a === b) return 1
	const longest = Math.max(a.length, b.length)

	if (longest === 0) return 1

	return 1 - levenshteinDistance(a, b) / longest
}

/**
 * Name-aware similarity in [0, 1]. Jaro-Winkler by default, with the compound-surname fallback the literature
 * prescribes:
 *
 * - If one name's tokens are a strict subset of the other's (`Lopez` ⊂ `Garcia Lopez`), that is strong partial agreement
 *   J-W misses — floor the score at 0.9.
 * - Otherwise return the better of Jaro-Winkler and normalized edit similarity, so a single token that is a substring of
 *   a longer compound (`Garcia` vs `Garcialopez`) still scores sensibly.
 *
 * Case- and whitespace-insensitive. Empty input scores 0.
 */
export function nameSimilarity(a: string, b: string): number {
	const x = a.trim().toLowerCase().replace(/\s+/g, " ")
	const y = b.trim().toLowerCase().replace(/\s+/g, " ")

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
