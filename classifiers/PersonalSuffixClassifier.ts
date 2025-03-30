// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { PhraseClassifier, prepareLocaleIndex, Span } from "mailwoman/core"

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

		if (this.index.has(span.normalized.replace(/\.$/, ""))) {
			span.classifications.add("personal_suffix")
		}
	}
}
