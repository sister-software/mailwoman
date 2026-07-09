/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { LibPostalLanguageCode, LocaleIndex } from "@mailwoman/core/resources"
import { Span, TokenContext } from "@mailwoman/core/tokenization"

import type { Classifier, ClassifierOptions } from "./BaseClassifier.ts"

export abstract class WordClassifier implements Classifier {
	/**
	 * A mapping of words to their originating languages.
	 *
	 * Each key is a word, and each value is a set of ISO 639-1 language codes.
	 */
	public index!: LocaleIndex<LibPostalLanguageCode>
	protected languages?: LibPostalLanguageCode[]

	constructor({ languages }: ClassifierOptions = {}) {
		this.languages = languages ? Array.from(languages) : undefined
	}

	abstract explore(span: Span, sectionIndex?: number, childIndex?: number): void

	public classifyTokens(context: TokenContext): void {
		for (const [sectionIndex, section] of context.sections.entries()) {
			let childIndex = 0

			for (const child of section.children) {
				this.explore(child, sectionIndex, childIndex)

				childIndex++
			}
		}
	}

	public classify(input: Span | string): Span {
		const span = Span.from(input)

		this.explore(span)

		return span
	}
}
