/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PhraseClassifier, prepareLocaleIndex, Span } from "@mailwoman/core"

export class SurnameClassifier extends PhraseClassifier {
	public async ready(): Promise<this> {
		const languages = this.languages || ["all"]

		this.index = await prepareLocaleIndex(languages, "surnames.txt", {
			lowercase: true,
			// Omit short names
			minLength: 3,
		})

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		const languages = this.index.get(span.normalized)

		if (languages) {
			span.classifications.add({
				classification: "surname",
				languages,
			})
		}
	}
}
