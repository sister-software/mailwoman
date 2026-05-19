/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @copyright Sister Software
 * @license AGPL-3.0
 * @abstract
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode } from "@mailwoman/core"
import { Span, TokenContext } from "@mailwoman/core/tokenization"

export interface Classifier {
	/**
	 * Explore a span, classifying its children.
	 *
	 * API consumers, implement this method to classify the children of a span.
	 *
	 * @see {@link classify} for public classification.
	 */
	explore?(span: Span, ...args: unknown[]): void

	/**
	 * Optional async method to prepare the classifier before classification.
	 */
	ready?(): Promise<this>

	/**
	 * Perform classification on the given context.
	 */
	classifyTokens(context: TokenContext): void

	/**
	 * Perform classification on the given input.
	 */
	classify(input: Span | string): Span
}

export interface ClassifierOptions {
	languages?:
		| Alpha2LanguageCode[]
		| readonly Alpha2LanguageCode[]
		| Set<Alpha2LanguageCode>
		| ReadonlySet<Alpha2LanguageCode>
}

export type ClassifierConstructor = new (options?: ClassifierOptions) => Classifier
