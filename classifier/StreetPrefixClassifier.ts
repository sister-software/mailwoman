/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import StreetPrefixClassification from "../classification/StreetPrefixClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

// prefix languages
// languages which use a street prefix instead of a suffix
const prefix = ["fr", "ca", "es", "pt", "ro", "pl"]

class StreetPrefixClassifier extends WordClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		// load street tokens
		this.index = {}
		libpostal.load(this.index, prefix, "street_types.txt")
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// base confidence
		let confidence = 1

		// use an inverted index for full token matching as it's O(1)
		if (Object.hasOwn(this.index, span.norm)) {
			if (span.norm.length < 2) {
				confidence = 0.2
			} // single letter streets are uncommon
			span.classify(new StreetPrefixClassification(confidence))
			return
		}

		// try again for abbreviations denoted by a period such as 'str.', also O(1)
		if (span.contains.final.period && Object.hasOwn(this.index, span.norm.slice(0, -1))) {
			if (span.norm.length < 3) {
				confidence = 0.2
			} // single letter streets are uncommon
			span.classify(new StreetPrefixClassification(confidence))
		}
	}
}

export default StreetPrefixClassifier
