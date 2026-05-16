/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span, WordClassifier } from "@mailwoman/core"

const AllNumbersPattern = /^#?\d+$/
const SingleLetterPattern = /^#?[A-Za-z]$/
const NumbersThenLetterPattern = /^#?\d+-?[A-Za-z]$/
const LetterThenNumbersPattern = /^#?[A-Za-z]-?\d+$/

function combinePatterns(...patterns: RegExp[]) {
	const components = patterns.map((arg) => arg.source)

	const combined = new RegExp("(?:" + components.join(")|(?:") + ")")
	return combined
}

const combinedUnitRegexp = combinePatterns(
	AllNumbersPattern,
	SingleLetterPattern,
	NumbersThenLetterPattern,
	LetterThenNumbersPattern
)

export class UnitClassifier extends WordClassifier {
	public explore(span: Span): void {
		const prev = span.previousSibling
		const hasPrevUnitToken = prev?.is("unit_designator")

		// If the previous token in a unit word, like apt or suite
		// and this token is something like A2, 3b, 120, A, label it as a unit (number)
		if (hasPrevUnitToken && combinedUnitRegexp.test(span.body)) {
			span.classifications.add("unit")
		}

		// A token that starts with a '#' and is not the first token in the query
		// and matches our regexp is always labeled as a unit
		if (span.body[0] === "#" && prev && combinedUnitRegexp.test(span.body)) {
			span.classifications.add("unit")
		}
	}

	public override classify(input: Span | string, prev?: Span | string): Span {
		const span = Span.from(input)

		if (prev) {
			span.previousSiblings.add(
				Span.from(prev, {
					classifications: ["unit_designator"],
				})
			)
		}

		this.explore(span)

		return span
	}
}
