/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import MiddleInitialClassification from "../classification/MiddleInitialClassification.js"
import { Span } from "../tokenization/Span.js"
import PhraseClassifier from "./super/PhraseClassifier.js"

const SingleLetterRegExp = /^[A-Za-z]\.?$/

class MiddleInitialClassifier extends PhraseClassifier {
	constructor() {
		super()
	}

	each(span: Span) {
		if (SingleLetterRegExp.test(span.body)) {
			span.classify(new MiddleInitialClassification(1))
		}
	}
}

export default MiddleInitialClassifier
