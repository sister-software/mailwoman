/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import PlaceClassification from "../classification/PlaceClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

// dictionaries sourced from the libpostal project
// see: https://github.com/openvenues/libpostal

class PlaceClassifier extends WordClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		libpostal.load(this.index, ["fr", "de", "en", "pl"], "place_names.txt")

		libpostal.generatePlurals(this.index)
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// do not classify tokens preceeded by an 'IntersectionClassification'
		const firstChild = span.graph.findOne("child:first") || span
		const prev = firstChild.graph.findOne("prev")
		if (prev && prev.classifications.hasOwnProperty("IntersectionClassification")) {
			return
		}

		// use an inverted index for full token matching as it's O(1)
		if (Object.hasOwn(this.index, span.norm)) {
			span.classify(new PlaceClassification(1.0))
		}
	}
}

export default PlaceClassifier
