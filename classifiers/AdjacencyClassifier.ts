/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SectionClassifier, Span } from "@mailwoman/core"

/**
 * An adjacency classifier is used to find three adjacent words in a section.
 *
 * The first word must be a house number, the second word must be a street, and the third word must be a street suffix.
 */
export class AdjacencyClassifier extends SectionClassifier {
	explore(section: Span): void {
		Array.from(section.children).forEach((primaryChild, i, children: readonly Span[]) => {
			// skip last two elements
			if (i >= section.children.size - 2) return

			const secondaryChild = children[i + 1]!
			const tertiaryChild = children[i + 2]!

			const primaryChildHasHouseNumber = primaryChild.is("house_number")
			const secondaryChildHasStreet = secondaryChild.is("street")
			const secondaryChildPhraseHasStreet = SectionClassifier.findPhrasesContaining(section, secondaryChild).some(
				(p) => {
					return p.is("street")
				}
			)

			const tertiaryChildHasStreetSuffix = tertiaryChild.is("street_suffix")

			if (
				primaryChildHasHouseNumber &&
				(secondaryChildHasStreet || secondaryChildPhraseHasStreet) &&
				tertiaryChildHasStreetSuffix
			) {
				// Every child must be part of the set above and must not omit any children.
				const matches = Iterator.from(section.phrases).filter((phrase) => {
					if (phrase.children.size !== 3) return false

					const [primaryPhrase, secondPhrase, tertiaryPhrase] = phrase.children

					return (
						// ---
						primaryPhrase === primaryChild &&
						// ---
						secondPhrase === secondaryChild &&
						// ---
						tertiaryPhrase === tertiaryChild
					)
				})

				for (const match of matches) {
					match.classifications.add("adjacent")
				}
			}
		})
	}
}
