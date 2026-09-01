/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The lowercased phrase → entries index both matching cores build (`lookup-core.ts` for categories,
 *   `brands-lookup-core.ts` for brands), plus the deterministic string order their tie-breaks share. Zero node
 *   imports, so it stays bundler-safe. Not exported via a subpath of its own.
 */

/**
 * Build a lowercased phrase index. `populate` receives `add`, which keys each entry by the lowercased phrase; multiple
 * entries may share a key.
 */
export function createPhraseIndex<Entry>(
	populate: (add: (phrase: string, entry: Entry) => void) => void
): ReadonlyMap<string, ReadonlyArray<Entry>> {
	const map = new Map<string, Entry[]>()

	populate((phrase, entry) => {
		const key = phrase.toLowerCase()
		const existing = map.get(key) ?? []
		existing.push(entry)
		map.set(key, existing)
	})

	return map
}

/**
 * A locale-independent string order for deterministic tie-breaks. `localeCompare` answers differently under different
 * ICU builds; code-point order is reproducible everywhere. A local copy of `@mailwoman/core/strings/compare`'s
 * `compareByCodePoint` — this package keeps `@mailwoman/core` out of its runtime graph.
 */
export function compareByCodePoint(left: string, right: string): number {
	if (left < right) return -1

	if (left > right) return 1

	return 0
}
