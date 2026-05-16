/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, PhraseClassifier, Span, prepareLocaleIndex } from "@mailwoman/core"

export class PersonClassifier extends PhraseClassifier {
	public async ready(): Promise<this> {
		this.index = await prepareLocaleIndex(
			this.languages ?? [
				// ---
				"all",
				Alpha2LanguageCode.French,
			],
			"people.txt",
			{
				lowercase: true,
			}
		)

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		const languages = this.index.get(span.normalized)

		if (!languages) return

		span.classifications.add({
			classification: "person",
			languages,
		})
	}
}
