/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { getAvailableLanguages, prefixedLanguages, prepareLocaleIndex, Span, WordClassifier } from "@mailwoman/core"

export class StreetSuffixClassifier extends WordClassifier {
	public async ready(): Promise<this> {
		const compatibleLanguages = Iterator
			// ---
			.from(this.languages ?? (await getAvailableLanguages()))
			.filter((language) => !prefixedLanguages.has(language))
			.toArray()

		this.index = await prepareLocaleIndex(compatibleLanguages, "street_types.txt", {
			// Likely to be noise.
			minLength: 2,
		})

		return this
	}

	public explore(span: Span, _sectionIndex?: number, childIndex?: number): void {
		if (span.flags.has("numeral")) return

		// Assuming that a street suffix should not appear as the first child token.
		if (childIndex === 0) return

		const languages = this.index.get(span.normalized)

		if (languages) {
			span.classifications.add({
				classification: "street_suffix",
				languages,
				// Single letter streets are uncommon.
				confidence: span.normalized.length === 1 ? 0.2 : 1,
			})

			return
		}

		// Try again for abbreviations denoted by a period such as 'str.'
		if (span.flags.has("ends_with_period")) {
			const languagesViaAbbreviation = this.index.get(span.normalized.slice(0, -1))

			if (!languagesViaAbbreviation) return

			span.classifications.add({
				classification: "street_suffix",
				languages: languagesViaAbbreviation,
				// Similar to single letter streets, short abbreviations are uncommon.
				confidence: span.normalized.length < 3 ? 0.2 : 1,
			})
		}
	}
}
