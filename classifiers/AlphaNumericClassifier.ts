/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span, WordClassifier } from "@mailwoman/core"

export class AlphaNumericClassifier extends WordClassifier {
	public explore(span: Span): void {
		if (span.flags.has("numeric")) {
			span.classifications.add("numeric")
		} else if (span.flags.has("numeral")) {
			span.classifications.add("alphanumeric")
		} else if (span.flags.has("punctuation")) {
			span.classifications.add("punctuation")
		} else {
			span.classifications.add("alpha")
		}
	}
}
