// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Alpha2LanguageCode, prepareLocaleIndex, Span, WordClassifier } from "mailwoman/core"

export class ToponymClassifier extends WordClassifier {
	public async ready(): Promise<this> {
		const languages = this.languages ?? [Alpha2LanguageCode.English]

		this.index = await prepareLocaleIndex(languages, "toponyms.txt")

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		const languages = this.index.get(span.normalized)

		if (!languages) return

		span.classifications.add({
			classification: "toponym",
			confidence: 1,
			languages,
		})
	}
}
