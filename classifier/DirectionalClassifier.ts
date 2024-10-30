/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import DirectionalClassification from "../classification/DirectionalClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

// const languages = libpostal.languages

// optionally control which languages are included
// note: reducing the languages will have a considerable performance benefit
const languages = ["en", "es", "de", "fr", "nl", "nb"] as const

class DirectionalClassifier extends WordClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		libpostal.load(this.index, languages, "directionals.txt")
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// use an inverted index for full token matching as it's O(1)
		if (Object.hasOwn(this.index, span.norm)) {
			span.classify(new DirectionalClassification(1))

			// try again for abbreviations denoted by a period such as 'n.'
		} else if (span.norm.slice(-1) === "." && Object.hasOwn(this.index, span.norm.slice(0, -1))) {
			span.classify(new DirectionalClassification(1))
		}
	}
}

export default DirectionalClassifier
