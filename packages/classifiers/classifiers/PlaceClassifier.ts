/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, prepareLocaleIndex, Span, WordClassifier } from "@mailwoman/core"

export class PlaceClassifier extends WordClassifier {
	public async ready(): Promise<this> {
		const languages = Array.from(
			this.languages ?? [
				// ---
				Alpha2LanguageCode.French,
				Alpha2LanguageCode.German,
				Alpha2LanguageCode.English,
				Alpha2LanguageCode.Polish,
			]
		)

		this.index = await prepareLocaleIndex(languages, "place_names.txt", {
			pluralize: true,
		})

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		const firstChild = span.children.first || span
		const prev = firstChild.previousSibling

		if (prev && prev.is("intersection")) {
			return
		}

		const languages = this.index.get(span.normalized)

		if (languages) {
			span.classifications.add({
				classification: "place",
				languages,
			})
		}
	}
}
