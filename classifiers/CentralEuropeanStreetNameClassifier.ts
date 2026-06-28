/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SectionClassifier, Span } from "@mailwoman/core"

/**
 * Classifies street names with no suffix or prefix when accompanied by a house number in the same section.
 *
 * @see {@link https://github.com/pelias/parser/issues/83 | Issue #83}
 */
export class CentralEuropeanStreetNameClassifier extends SectionClassifier {
	public explore(section: Span): void {
		const { first, last } = section.children

		// Does the section have at least two children?
		if (!first || !last) return

		// Is the first child a toponym, like a region or city?
		if (first.is("toponym")) return

		// Section doesn't end with a housenumber?
		if (!last.is("house_number")) return

		// Other elements cannot contain any public classifications.
		if (first.classifications.hasVisibleClassification()) return

		// Assume the first token is a street name...
		first.classifications.add({
			classification: "street",
			confidence: 0.5,
			flags: new Set(["central_european_street_name"]),
		})
	}
}
