/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import StreetClassification from "../classification/StreetClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

class CompoundStreetClassifier extends WordClassifier {
	public suffixes: libpostal.PostalIndex = {}

	constructor() {
		super()

		libpostal.load(this.suffixes, ["de", "nl", "sv", "nb"], "concatenated_suffixes_separable.txt", {
			// remove any suffixes which contain less than 3 characters (excluding a period)
			// this removes suffixes such as 'r.' which can be ambiguous
			minlength: 3,
		})

		libpostal.load(this.suffixes, ["de", "nl", "nb"], "concatenated_suffixes_inseparable.txt", {
			// remove any suffixes which contain less than 3 characters (excluding a period)
			// this removes suffixes such as 'r.' which can be ambiguous
			minlength: 3,
		})
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// else use a slower suffix check which is O(n)
		// this allows us to match Germanic compound words such as:
		// 'Grolmanstraße' which end with the dictionary term '-straße'
		for (const token in this.suffixes) {
			const offet = span.body.length - token.length

			if (offet < 1) {
				continue
			}

			// perf: https://gist.github.com/dai-shi/4950506
			if (span.norm.substring(offet) === token) {
				span.classify(new StreetClassification(1.0))
				return
			}
		}
	}
}

export default CompoundStreetClassifier
