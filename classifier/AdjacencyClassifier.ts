/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import AdjacentClassification from "../classification/AdjacentClassification.js"
import { Span } from "../tokenization/Span.js"
import SectionClassifier from "./super/SectionClassifier.js"

// find three adjacent words
// {housenumber} {street} {street_suffix}
// @todo: expand the scheme internationally and make this
// functionality more generic

class AdjacencyClassifier extends SectionClassifier {
	each(section: Span) {
		const children = section.graph.findAll("child")
		children.forEach((_, cc) => {
			// skip last two elements
			if (cc >= section.graph.length("child") - 2) {
				return
			}

			if (
				children[cc + 0]!.classifications.hasOwnProperty("HouseNumberClassification") &&
				(children[cc + 1]!.classifications.hasOwnProperty("StreetClassification") ||
					SectionClassifier.findPhrasesContaining(section, children[cc + 1]!).some((p) =>
						p.classifications.hasOwnProperty("StreetClassification")
					)) &&
				children[cc + 2]!.classifications.hasOwnProperty("StreetSuffixClassification")
			) {
				// every child must be part of the set above
				// and must not omit any children
				const matches = section.graph.findAll("phrase").filter((p) => {
					const ch = p.graph.findAll("child")
					return (
						ch.length === 3 &&
						ch[cc + 0] === children[cc + 0] &&
						ch[cc + 1] === children[cc + 1] &&
						ch[cc + 2] === children[cc + 2]
					)
				})

				if (matches.length) {
					// classify all matches
					matches.forEach((m) => m.classify(new AdjacentClassification(1.0)))
				}
			}
		})
	}
}

export default AdjacencyClassifier
