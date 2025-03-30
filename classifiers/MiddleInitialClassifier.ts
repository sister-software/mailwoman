// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Alpha2LanguageCode, PhraseClassifier, Span } from "mailwoman/core"

const SingleLetterPattern = /^[A-Za-z]\.?$/

export class MiddleInitialClassifier extends PhraseClassifier {
	public explore(span: Span): void {
		if (SingleLetterPattern.test(span.body)) {
			span.classifications.add({
				classification: "middle_initial",
				languages: new Set(Alpha2LanguageCode.English),
			})
		}
	}
}
