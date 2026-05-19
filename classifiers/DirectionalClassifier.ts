/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, Span, WordClassifier, prepareLocaleIndex } from "@mailwoman/core"

export class DirectionalClassifier extends WordClassifier {
	public async ready(): Promise<this> {
		this.index = await prepareLocaleIndex(
			this.languages || [
				Alpha2LanguageCode.English,
				Alpha2LanguageCode.Spanish,
				Alpha2LanguageCode.German,
				Alpha2LanguageCode.French,
				Alpha2LanguageCode.Dutch,
				Alpha2LanguageCode.NorwegianBokmål,
			],
			"directionals.txt"
		)

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		if (this.index.has(span.normalized)) {
			span.classifications.add("directional")

			// try again for abbreviations denoted by a period such as 'n.'
		} else if (span.normalized.slice(-1) === "." && this.index.has(span.normalized.slice(0, -1))) {
			span.classifications.add("directional")
		}
	}
}
