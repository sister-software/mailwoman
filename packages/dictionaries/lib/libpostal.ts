/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runtime readers of the vendored libpostal dictionaries.
 *
 *   The dictionaries are mostly build input: the corpus street-decompose adapters read
 *   them. `gazetteer-pipeline/{fst,street-morphology,evidence-lexicons}` compile them into the
 *   artifacts the parser loads at runtime. The POI category lookup reads one language's stopwords
 *   at session start.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { libpostalLineSurfaces } from "@mailwoman/core/resources/libpostal"
import { TextSpliterator } from "spliterator"

import { resourceDictionaryPathBuilder } from "#paths"

/**
 * Single-word stopwords a language's libpostal `stopwords.txt` omits, keyed by language.
 *
 * English lists `a` and `the` and omits `an`.
 */
export const LIBPOSTAL_STOPWORD_SUPPLEMENT: Readonly<Record<string, readonly string[]>> = {
	en: ["an"],
}

/**
 * The lowercased single-word stopwords libpostal lists for `language`, such as `the`
 * and `a` in English or `la` and `des` in French, with {@link LIBPOSTAL_STOPWORD_SUPPLEMENT}.
 *
 * A language libpostal has no stopword file for returns only its supplement.
 */
export async function readLibPostalSingleWordStopwords(language: string): Promise<ReadonlySet<string>> {
	const path = resourceDictionaryPathBuilder("libpostal", language, "stopwords.txt")
	const words = new Set<string>(LIBPOSTAL_STOPWORD_SUPPLEMENT[language])

	if (!(await pathExists(path))) return words

	for (const line of TextSpliterator.from(await readLocalTextFile(path))) {
		for (const surface of libpostalLineSurfaces(line)) {
			const word = surface.trim().toLocaleLowerCase(language)

			if (word && !/\s/u.test(word)) {
				words.add(word)
			}
		}
	}

	return words
}
