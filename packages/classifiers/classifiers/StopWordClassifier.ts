/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, prepareLocaleIndex, Span, WordClassifier } from "@mailwoman/core"

/**
 * A classifier that identifies stop words, i.e. prepositions and articles.
 */
export class StopWordClassifier extends WordClassifier {
	public async ready(): Promise<this> {
		const languages = this.languages ?? [
			//---

			Alpha2LanguageCode.French,
			Alpha2LanguageCode.German,
			Alpha2LanguageCode.English,
			Alpha2LanguageCode.Portuguese,
		]

		this.index = await prepareLocaleIndex(languages, "stopwords.txt")

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		let confidence = 0.75

		const languages = this.index.get(span.normalized)

		if (languages) {
			if (span.normalized.length < 2) {
				confidence = 0.2
			}

			span.classifications.add({ classification: "stop_word", confidence, languages })
		}
	}
}
