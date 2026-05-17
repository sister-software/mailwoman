/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span, TokenContext } from "@mailwoman/core/tokenization"
import { Classifier } from "./BaseClassifier.js"

export interface SectionClassifierUtils {
	findPhrasesContaining: (child: Span) => Span[]
}

export abstract class SectionClassifier implements Classifier {
	/**
	 * Explore a span, classifying its children.
	 */
	abstract explore(span: Span): void

	classifyTokens(context: TokenContext): void {
		for (const section of context.sections) {
			this.explore(section)
		}
	}

	classify(input: Span | string): Span {
		const span = Span.from(input)

		this.explore(span)

		return span
	}

	/**
	 * Find all phrases containing a child span.
	 */
	static findPhrasesContaining(section: Span, child: Span) {
		return Iterator.from(section.phrases).filter((phrase) => {
			return Iterator.from(phrase.children).some((phraseChild) => phraseChild === child)
		})
	}
}
