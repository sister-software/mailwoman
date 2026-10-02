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
 * The candidate list this replaced named one of them twice, guessed a third path from `process.cwd()`,
 * and swallowed every error while probing, so a corrupt dictionary reported as a missing one.
 *
 * The largest dictionary is 8.4 KB, and each caller loads it once per process at module load.
 */
export async function loadLibpostalDictionary(language: string, filename: string): Promise<Set<string>> {
	const text = await readLocalTextFile(resourceDictionaryPath("libpostal", language, filename))
	const set = new Set<string>()

	for (const line of TextSpliterator.from(text)) {
		if (line.startsWith("#")) continue

		for (const form of TextSpliterator.from(line, { delimiter: "|" })) {
			set.add(form.toLowerCase())
		}
	}

	return set
}
