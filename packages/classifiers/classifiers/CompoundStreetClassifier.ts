/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	Alpha2LanguageCode,
	LibPostalLanguageCode,
	LocaleIndex,
	prepareLocaleIndex,
	Span,
	WordClassifier,
} from "@mailwoman/core"

export class CompoundStreetClassifier extends WordClassifier {
	public suffixes!: LocaleIndex<LibPostalLanguageCode>

	async ready(): Promise<this> {
		const [separable, inseparable] = await Promise.all([
			prepareLocaleIndex(
				[
					Alpha2LanguageCode.German,
					Alpha2LanguageCode.Dutch,
					Alpha2LanguageCode.Swedish,
					Alpha2LanguageCode.NorwegianBokmål,
				],
				"concatenated_suffixes_separable.txt",
				{
					// Removes suffixes such as 'r.' which can be ambiguous
					minLength: 3,
				}
			),
			prepareLocaleIndex(
				[Alpha2LanguageCode.German, Alpha2LanguageCode.Dutch, Alpha2LanguageCode.NorwegianBokmål],
				"concatenated_suffixes_inseparable.txt",
				{
					// Removes suffixes such as 'r.' which can be ambiguous
					minLength: 3,
				}
			),
		])

		this.suffixes = new LocaleIndex<LibPostalLanguageCode>([...separable, ...inseparable], {
			displayName: "libpostal",
		})

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		// else use a slower suffix check which is O(n)
		// this allows us to match Germanic compound words such as:
		// 'Grolmanstraße' which end with the dictionary term '-straße'
		for (const [token, languages] of this.suffixes) {
			const offset = span.body.length - token.length

			if (offset < 1) continue

			if (span.normalized.substring(offset) === token) {
				span.classifications.add({
					classification: "street",
					languages,
				})

				return
			}
		}
	}
}
