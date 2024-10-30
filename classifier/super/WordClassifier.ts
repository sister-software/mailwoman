/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "../../tokenization/Span.js"
import { Tokenizer } from "../../tokenization/Tokenizer.js"
import { Classifier, ClassifyInput } from "./BaseClassifier.js"

export abstract class WordClassifier implements Classifier {
	abstract each(span: Span, sectionIndex?: number | null, childIndex?: number): void

	classifyTokenizer(tokenizer: Tokenizer) {
		for (let sectionIndex = 0; sectionIndex < tokenizer.section.length; sectionIndex++) {
			const children = tokenizer.section[sectionIndex]!.graph.findAll("child")

			for (let childIndex = 0; childIndex < children.length; childIndex++) {
				this.each(children[childIndex]!, sectionIndex, childIndex)
			}
		}
	}

	classify(input: ClassifyInput): Span {
		const span = Span.from(input)

		this.each(span)

		return span
	}
}
