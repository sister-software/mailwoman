/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { LevelTypeClassification } from "../classification/LevelTypeClassification.js"
import * as libpostal from "../resources/libpostal/libpostal.js"
import { Span } from "../tokenization/Span.js"
import { WordClassifier } from "./super/WordClassifier.js"

export class LevelTypeClassifier extends WordClassifier {
	public index: libpostal.PostalIndex = {}

	constructor() {
		super()

		libpostal.load(this.index, ["en"], "level_types_numbered.txt")
	}

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// use an inverted index for full token matching as it's O(1)
		if (Object.hasOwn(this.index, span.norm)) {
			span.classify(new LevelTypeClassification(1.0))
		}
	}
}
