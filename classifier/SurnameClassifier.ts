/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import SurnameClassification from "../classification/SurnameClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import PhraseClassifier from "./super/PhraseClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

class SurnameClassifier extends PhraseClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		this.index = {}
		libpostal.load(this.index, ["all"], "surnames.txt", {
			lowercase: true,
			minlength: 3, // prevent very short names being indexed
		})
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// use an inverted index for full token matching as it's O(1)
		if (Object.hasOwn(this.index, span.norm)) {
			span.classify(new SurnameClassification(1))
		}
	}
}

export default SurnameClassifier
