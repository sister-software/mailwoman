/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import PersonalSuffixClassification from "../classification/PersonalSuffixClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import PhraseClassifier from "./super/PhraseClassifier.js"

class PersonalSuffixClassifier extends PhraseClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		libpostal.load(this.index, libpostal.languages, "personal_suffixes.txt", {
			replace: {
				from: /\.$ /,
				to: "",
			},
		})
	}

	each(span: Span) {
		if (span.contains.numerals) return

		// use an inverted index for full token matching as it's O(1)
		if (Object.hasOwn(this.index, span.norm.replace(/\.$/, ""))) {
			span.classify(new PersonalSuffixClassification(1))
		}
	}
}

export default PersonalSuffixClassifier
