/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import LevelClassification from "../classification/LevelClassification.js"
import { LevelTypeClassification } from "../classification/LevelTypeClassification.js"
import { Span } from "../tokenization/Span.js"
import { ClassifyInput } from "./super/BaseClassifier.js"
import { WordClassifier } from "./super/WordClassifier.js"

const combinedFloorRegexp = /^\d{1,2}$/

export class LevelClassifier extends WordClassifier {
	each(span: Span) {
		const prev = span.graph.findOne("prev")
		const hasPrevLevelToken = prev?.classifications
			? Object.hasOwn(prev.classifications, "LevelTypeClassification")
			: false

		// If the previous token in a level word, like floor, fl, or floor.
		if (hasPrevLevelToken && combinedFloorRegexp.test(span.body)) {
			span.classify(new LevelClassification(1))
		}

		// // A token that starts with a '#' and is not the first token in the query
		// // and matches our regexp is always labeled as a level
		// if (span.body[0] === "FLOOR" && prev && combinedFloorRegexp.test(span.body)) {
		// 	span.classify(new LevelClassification(1))
		// }
	}

	override classify(input: ClassifyInput, prev?: ClassifyInput): Span {
		const span = Span.from(input)

		if (prev) {
			const p = Span.from(prev)

			p.classify(new LevelTypeClassification(1.0))
			span.graph.add("prev", p)
		}

		this.each(span)

		return span
	}
}
