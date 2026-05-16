/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span, WordClassifier, prefixedLanguages, prepareLocaleIndex } from "@mailwoman/core"

export class StreetPrefixClassifier extends WordClassifier {
	public async ready(): Promise<this> {
		const languages = Array.from(this.languages ?? prefixedLanguages)

		this.index = await prepareLocaleIndex(languages, "street_types.txt")

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		let languages = this.index.get(span.normalized)

		if (languages) {
			span.classifications.add({
				classification: "street_prefix",
				// Single letter streets are uncommon.
				confidence: span.normalized.length < 2 ? 0.2 : 1,
				languages,
			})

			return
		}

		// Try again for abbreviations denoted by a period such as 'str.'
		if (!span.flags.has("ends_with_period")) return

		languages = this.index.get(span.normalized.slice(0, -1))

		if (!languages) return

		span.classifications.add({
			classification: "street_prefix",
			// Similar to single letter streets, short abbreviations are uncommon.
			confidence: span.normalized.length < 3 ? 0.2 : 1,
			languages,
		})
	}
}
