/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import ChainClassification from "../classification/ChainClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import PhraseClassifier from "./super/PhraseClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

class ChainClassifier extends PhraseClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		libpostal.load(this.index, ["all"], "chains.txt")
	}

	each(span: Span) {
		// use an inverted index for full token matching as it's O(1)
		if (Object.hasOwn(this.index, span.norm)) {
			span.classify(new ChainClassification(1))
		}
	}
}

export default ChainClassifier
