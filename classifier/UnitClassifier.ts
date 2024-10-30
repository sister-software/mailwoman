/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { UnitClassification } from "../classification/UnitClassification.js"
import { UnitTypeClassification } from "../classification/UnitTypeClassification.js"
import { Span } from "../tokenization/Span.js"
import { ClassifyInput } from "./super/BaseClassifier.js"
import { WordClassifier } from "./super/WordClassifier.js"

const AllNumbersRegExp = /^#?\d+$/
const SingleLetterRegExp = /^#?[A-Za-z]$/
const NumbersThenLetterRegExp = /^#?\d+-?[A-Za-z]$/
const LetterThenNumbersRegExp = /^#?[A-Za-z]-?\d+$/

// based on https://stackoverflow.com/questions/9213237/combining-regular-expressions-in-javascript
function combineRegExps(...patterns: RegExp[]) {
	const components = patterns.map((arg) => arg.source)

	const combined = new RegExp("(?:" + components.join(")|(?:") + ")")
	return combined
}

const combinedUnitRegexp = combineRegExps(
	AllNumbersRegExp,
	SingleLetterRegExp,
	NumbersThenLetterRegExp,
	LetterThenNumbersRegExp
)

export class UnitClassifier extends WordClassifier {
	each(span: Span) {
		const prev = span.graph.findOne("prev")
		const hasPrevUnitToken = prev?.classifications
			? Object.hasOwn(prev.classifications, "UnitTypeClassification")
			: false

		// If the previous token in a unit word, like apt or suite
		// and this token is something like A2, 3b, 120, A, label it as a unit (number)
		if (hasPrevUnitToken && combinedUnitRegexp.test(span.body)) {
			span.classify(new UnitClassification(1))
		}

		// A token that starts with a '#' and is not the first token in the query
		// and matches our regexp is always labeled as a unit
		if (span.body[0] === "#" && prev && combinedUnitRegexp.test(span.body)) {
			span.classify(new UnitClassification(1))
		}
	}

	override classify(input: ClassifyInput, prev?: ClassifyInput): Span {
		const span = Span.from(input)

		if (prev) {
			const p = Span.from(prev)

			p.classify(new UnitTypeClassification(1.0))
			span.graph.add("prev", p)
		}

		this.each(span)

		return span
	}
}
