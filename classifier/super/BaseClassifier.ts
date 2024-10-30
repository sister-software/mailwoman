/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @abstract
 */

import { Span } from "../../tokenization/Span.js"
import { Tokenizer } from "../../tokenization/Tokenizer.js"

export type ClassifyInput = Span | string

export interface Classifier {
	each?(span: Span, ...args: any[]): void

	/**
	 * Perform classification on the given tokenizer.
	 */
	classifyTokenizer(tokenizer: Tokenizer): void

	classify(input: ClassifyInput): Span
}

/**
 * Create a static classifier from a classifier class.
 *
 * This is useful for testing classifiers that only need to be instantiated once.
 */
export function createStaticClassifier(Classifier: new () => Classifier) {
	const classifier = new Classifier()

	return (body: string) => {
		const span = new Span(body)

		classifier.each?.(span)

		return span
	}
}
