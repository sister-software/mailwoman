/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import IntersectionClassification from "../classification/IntersectionClassification.js"
import { Span } from "../tokenization/Span.js"
import PhraseClassifier from "./super/PhraseClassifier.js"

class IntersectionClassifier extends PhraseClassifier {
	public index = new Map<string, boolean>([
		["&", true],
		["and", true],
		["und", true],
		["@", true],
		["at", true],
		["con", true],
		["an der ecke von", true],
	])

	each(span: Span) {
		// skip spans which contain numbers
		if (span.contains.numerals) {
			return
		}

		// do not classify tokens with tokens missing before or afterwards
		const firstChild = span.graph.findOne("child:first") || span
		const prev = firstChild.graph.findOne("prev")
		const next = firstChild.graph.findOne("next")
		if (!prev || !next) {
			return
		}

		// use an inverted index for full token matching as it's O(1)
		if (this.index.has(span.norm)) {
			// classify phrase
			span.classify(new IntersectionClassification(1))

			// classify child spans
			span.graph.findAll("child").forEach((c) => c.classify(new IntersectionClassification(1)))
		}
	}
}

export default IntersectionClassifier
