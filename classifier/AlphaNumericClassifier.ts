/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import AlphaClassification from "../classification/AlphaClassification.js"
import AlphaNumericClassification from "../classification/AlphaNumericClassification.js"
import NumericClassification from "../classification/NumericClassification.js"
import PunctuationClassification from "../classification/PunctuationClassification.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

class AlphaNumericClassifier extends WordClassifier {
	each(span: Span) {
		if (/^\d+$/.test(span.norm)) {
			span.classify(new NumericClassification(1))
		} else if (span.contains.numerals) {
			span.classify(new AlphaNumericClassification(1))
		} else if (/^[@&/\\#,+()$~%.!^'";:*?[\]<>{}]+$/.test(span.norm)) {
			span.classify(new PunctuationClassification(1))
		} else {
			span.classify(new AlphaClassification(1))
		}
	}
}

export default AlphaNumericClassifier
