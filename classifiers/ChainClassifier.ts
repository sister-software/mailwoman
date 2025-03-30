// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { PhraseClassifier, Span, prepareLocaleIndex } from "mailwoman/core"

/**
 * Chain-restaurants and other franchises.
 */
export class ChainClassifier extends PhraseClassifier {
	public async ready(): Promise<this> {
		this.index = await prepareLocaleIndex(this.languages, "chains.txt")

		return this
	}

	public explore(span: Span): void {
		const languages = this.index.get(span.normalized)

		if (languages) {
			span.classifications.add({
				classification: "chain",
				languages,
			})
		}
	}
}
