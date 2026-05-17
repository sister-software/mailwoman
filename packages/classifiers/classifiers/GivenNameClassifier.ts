/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { PhraseClassifier, prepareLocaleIndex, Span, TextNormalizer } from "@mailwoman/core"

export class GivenNameClassifier extends PhraseClassifier {
	public async ready(): Promise<this> {
		this.index = await prepareLocaleIndex(
			this.languages ?? ["all"],
			"given_names.txt",
			new TextNormalizer({
				lowercase: true,
				// Omit short names.
				minLength: 3,
			})
		)

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		const languages = this.index.get(span.normalized)
		if (!languages) return

		const firstChild = span.children.first || span
		const { previousSibling } = firstChild

		// if (previousSibling?.is("stop_word")) return

		span.classifications.add({
			classification: "given_name",
			confidence: 1,
			languages,
		})
	}
}
