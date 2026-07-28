/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Soft name matching for locality ranking: case/diacritic folding, padded character trigrams, and the
 *   trigram-Jaccard score built on them. Shared by the FTS lookup and the candidate-table backend so
 *   both rank the same typo identically — the whole reason this is one module rather than two copies.
 */

/** Case-fold + strip diacritics + collapse punctuation — for the coord-first soft name match. */
export function cfNormalize(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/[\u0300-\u036F]/g, "") // combining diacritical marks
		.replaceAll(/[^a-z0-9]+/g, " ")
		.trim()
}

/** Padded character-trigram set (a leading/trailing space pads short tokens). */
export function trigrams(s: string): Set<string> {
	const t = ` ${s} `
	const out = new Set<string>()

	for (let i = 0; i + 3 <= t.length; i++) {
		out.add(t.slice(i, i + 3))
	}

	return out
}

/**
 * Character-trigram Jaccard ∈ [0,1] — tolerant of the swallowed-leading-char fragments ("auen" vs "plauen") and minor
 * misspellings without a heavyweight edit-distance pass. Shared with the candidate backend's FTS5-trigram fuzzy
 * fallback so both lookups rank typos identically.
 */
export function trigramJaccard(a: string, b: string): number {
	const A = trigrams(a)
	const B = trigrams(b)

	if (!A.size || !B.size) return 0
	let inter = 0

	for (const x of A)
		if (B.has(x)) {
			inter++
		}

	return inter / (A.size + B.size - inter)
}

/** Soft name-match score ∈ [0,1]: exact (normalized) name/alias → 1, else best trigram-Jaccard. */
export function softNameScore(text: string, name: string, aliases: readonly string[]): number {
	const q = cfNormalize(text)

	if (!q) return 0
	let best = 0

	for (const raw of [name, ...aliases]) {
		const n = cfNormalize(raw)

		if (!n) continue

		if (n === q) return 1
		best = Math.max(best, trigramJaccard(q, n))
	}

	return best
}
