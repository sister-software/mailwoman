/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PhraseClassifier, prepareLocaleIndex, Span } from "@mailwoman/core"

export class PersonalSuffixClassifier extends PhraseClassifier {
	public async ready(): Promise<this> {
		this.index = await prepareLocaleIndex(this.languages, "personal_suffixes.txt", {
			replace: [
				{
					from: /\.$/,
					to: "",
				},
			],
		})

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		const languages = this.index.get(span.normalized.replace(/\.$/, ""))

		if (!languages) return

		span.classifications.add({
			classification: "personal_suffix",
			languages,
		})
	}
}
