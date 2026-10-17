/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The curated libpostal dictionary reader the street-decompose modules share.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resourceDictionaryPath } from "@mailwoman/core/paths"
import { TextSpliterator } from "spliterator"

/**
 * Loads one curated libpostal dictionary as a lower-cased form set.
 *
 * A dictionary line reads `canonical|abbr|abbr|…` and every form is indexed,
 * so a lookup matches the canonical spelling and each abbreviation alike.
 * A line opening with `#` is a comment.
 *
 * `resourceDictionaryPath` resolves both layouts, `core/data/…` from source and the packaged `out/` tree.
 *
 * The largest dictionary is 8.4 KB, and each caller loads it once per process at module load.
 */
export async function loadLibpostalDictionary(language: string, filename: string): Promise<Set<string>> {
	return new Set((await loadLibpostalCanonicalForms(language, filename)).keys())
}

/**
 * Loads one curated libpostal dictionary as a map from each lower-cased form
 * to its line's canonical spelling.
 *
 * `ул.` and `улица` both map to `улица`, so a count of distinct canonical values
 * counts street types rather than their spellings.
 * A form two lines share keeps the first line's canonical spelling.
 */
export async function loadLibpostalCanonicalForms(language: string, filename: string): Promise<Map<string, string>> {
	const text = await readLocalTextFile(resourceDictionaryPath("libpostal", language, filename))
	const forms = new Map<string, string>()

	for (const line of TextSpliterator.from(text)) {
		if (line.startsWith("#")) continue

		let canonical: string | null = null

		for (const form of TextSpliterator.from(line, { delimiter: "|" })) {
			const lower = form.toLowerCase()

			canonical ??= lower

			if (!forms.has(lower)) {
				forms.set(lower, canonical)
			}
		}
	}

	return forms
}
