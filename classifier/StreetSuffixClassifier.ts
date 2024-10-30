/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import StreetSuffixClassification from "../classification/StreetSuffixClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

// prefix languages
// languages which use a street prefix instead of a suffix
// const prefix = ["fr", "ca", "es", "pt", "ro", "pl"]
const prefixedLanguages = new Set(["fr", "ca", "es", "pt", "ro", "pl"])

class StreetSuffixClassifier extends WordClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()
		const languages = libpostal.languages.difference(prefixedLanguages)

		// console.debug("StreetSuffixClassifier wants", languages)

		libpostal.load(
			// Exclude french types because they are street prefix
			this.index,

			languages,
			"street_types.txt"
		)

		// blacklist any token under 2 chars in length
		for (const token in this.index) {
			if (token.length < 2) {
				delete this.index[token]
			}
		}
	}

	each(span: Span, _sectionIndex: number | null = null, childIndex: number = 1) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// base confidence
		let confidence = 1

		// skip checking spans in the first position within their section
		// note: assuming that a street suffix should not appear as the first token
		if (childIndex > 0) {
			// use an inverted index for full token matching as it's O(1)
			if (Object.hasOwn(this.index, span.norm)) {
				if (span.norm.length < 2) {
					confidence = 0.2
				} // single letter streets are uncommon
				span.classify(new StreetSuffixClassification(confidence))
				return
			}

			// try again for abbreviations denoted by a period such as 'str.', also O(1)
			if (span.contains.final.period && Object.hasOwn(this.index, span.norm.slice(0, -1))) {
				if (span.norm.length < 3) {
					confidence = 0.2
				} // single letter streets are uncommon
				span.classify(new StreetSuffixClassification(confidence))
			}
		}
	}
}

export default StreetSuffixClassifier
