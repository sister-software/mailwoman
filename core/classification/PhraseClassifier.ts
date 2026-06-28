/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LibPostalLanguageCode, LocaleIndex } from "@mailwoman/core/resources"
import { Span, TokenContext } from "@mailwoman/core/tokenization"

import type { Classifier, ClassifierOptions } from "./BaseClassifier.js"

export abstract class PhraseClassifier implements Classifier {
	public index!: LocaleIndex<LibPostalLanguageCode>
	protected languages?: LibPostalLanguageCode[]

	constructor({ languages }: ClassifierOptions = {}) {
		this.languages = languages ? Array.from(languages) : undefined
	}

	/**
	 * Perform classification on the given span.
	 */
	abstract explore(span: Span, sectionIndex?: number, phraseIndex?: number): void

	/**
	 * Perform classification on the given context.
	 */
	public classifyTokens(context: TokenContext): void {
		for (const [sectionIndex, section] of context.sections.entries()) {
			const { phrases } = section

			let phraseIndex = 0

			for (const phrase of phrases) {
				this.explore(phrase, sectionIndex, phraseIndex)

				phraseIndex++
			}
		}
	}

	public classify(input: Span | string): Span {
		const span = Span.from(input)

		this.explore(span)

		return span
	}
}
