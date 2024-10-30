/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import RoadTypeClassification from "../classification/RoadTypeClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

class RoadTypeClassifier extends WordClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		libpostal.load(this.index, libpostal.languages, "road_types.txt")
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
			}
			span.classify(new RoadTypeClassification(confidence))
		}
	}
}

export default RoadTypeClassifier
