/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type Classifier, Span, TokenContext } from "@mailwoman/core"

/**
 * Classify the first and last tokens in a section.
 *
 * This is used to identify the start and end of a section, as well as improving autocomplete by identifying
 * single-character tokens.
 */
export class TokenPositionClassifier implements Classifier {
	public classifyTokens(context: TokenContext): void {
		const [firstSection] = context.sections

		if (!firstSection) return

		Iterator.from(firstSection.children)
			.filter((s) => !s.previousSibling)
			.forEach((firstChild) => {
				firstChild.classifications.add("start_token")
			})

		// End token.
		const lastSection = context.sections[context.sections.length - 1]!

		Iterator.from(lastSection.children)
			.filter(({ nextSibling }) => !nextSibling)
			.forEach((lastChild) => {
				lastChild.classifications.add("end_token")

				if (lastChild.normalized.length === 1) {
					lastChild.classifications.add("end_token_single_character")
				}
			})
	}

	/**
	 * @deprecated Use "classifyTokens" instead.
	 */
	public classify(_input: Span | string): Span {
		throw new TypeError('This classifier cannot be used to classify a span directly. Use "classifyTokens" instead.')
	}
}
