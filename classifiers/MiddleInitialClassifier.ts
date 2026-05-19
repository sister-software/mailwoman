/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, PhraseClassifier, Span } from "@mailwoman/core"

const SingleLetterPattern = /^[A-Za-z]\.?$/

export class MiddleInitialClassifier extends PhraseClassifier {
	public explore(span: Span): void {
		if (!SingleLetterPattern.test(span.body)) return

		span.classifications.add({
			classification: "middle_initial",
			languages: new Set([Alpha2LanguageCode.English]),
		})
	}
}
