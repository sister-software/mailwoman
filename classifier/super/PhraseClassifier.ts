/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "../../tokenization/Span.js"
import { Tokenizer } from "../../tokenization/Tokenizer.js"
import { Classifier, ClassifyInput } from "./BaseClassifier.js"

export abstract class PhraseClassifier implements Classifier {
	/**
	 * Perform classification on the given span.
	 */
	abstract each(span: Span, sectionIndex?: number, phraseIndex?: number): void

	// run classifier against every permutation produced by the tokenizer
	public classifyTokenizer(tokenizer: Tokenizer) {
		for (let sectionIndex = 0; sectionIndex < tokenizer.section.length; sectionIndex++) {
			const phrases = tokenizer.section[sectionIndex]!.graph.findAll("phrase")

			for (let phraseIndex = 0; phraseIndex < phrases.length; phraseIndex++) {
				this.each(phrases[phraseIndex]!, sectionIndex, phraseIndex)
			}
		}
	}

	classify(input: ClassifyInput): Span {
		const span = Span.from(input)

		this.each(span)

		return span
	}
}

export default PhraseClassifier
