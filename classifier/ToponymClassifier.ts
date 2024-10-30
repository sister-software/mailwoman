/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import ToponymClassification from "../classification/ToponymClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

class ToponymClassifier extends WordClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		// load street tokens
		this.index = {}
		libpostal.load(this.index, ["en"], "toponyms.txt")
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// use an inverted index for full token matching as it's O(1)
		if (Object.hasOwn(this.index, span.norm)) {
			span.classify(new ToponymClassification(1, this.index[span.norm]))
		}
	}
}

export default ToponymClassifier
