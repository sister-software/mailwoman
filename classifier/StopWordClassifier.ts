/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import StopWordClassification from "../classification/StopWordClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

class StopWordsClassifier extends WordClassifier {
	public stopWords: libpostal.PostalIndex = {}

	constructor() {
		super()

		// load stopwords tokens
		libpostal.load(this.stopWords, ["fr", "de", "en", "pt"], "stopwords.txt")
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// base confidence
		let confidence = 0.75

		// use an inverted index for full token matching as it's O(1)
		if (this.stopWords.hasOwnProperty(span.norm)) {
			if (span.norm.length < 2) {
				confidence = 0.2
			}
			span.classify(new StopWordClassification(confidence))
		}
	}
}

export default StopWordsClassifier
