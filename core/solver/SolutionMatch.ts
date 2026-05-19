/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassificationMatch, ClassificationsMatchInput } from "@mailwoman/core/classification"
import { Span } from "@mailwoman/core/tokenization"

export interface SerializedSolutionMatch extends ClassificationMatch {
	/**
	 * The span of text that was matched.
	 */
	readonly value: string

	/**
	 * The start index of the span.
	 */
	readonly start: number

	/**
	 * The end index of the span.
	 */
	readonly end: number
}

/**
 * Comparator for sorting solution matches by their start index.
 */
export function compareMatchesByStart(a: SolutionMatch, b: SolutionMatch) {
	return a.span.start - b.span.start
}

export class SolutionMatch implements SerializedSolutionMatch {
	/**
	 * The span of text that was matched.
	 */
	readonly span: Span

	/**
	 * Matched classifications and their respective metadata.
	 */
	readonly #match: ClassificationMatch

	/**
	 * The classification of the match.
	 */
	public get classification() {
		return this.#match.classification
	}

	/**
	 * The confidence of the match, from 0 to 1.
	 *
	 * This indicates how certain the classifier is that the match is correct.
	 */
	public get confidence() {
		return this.#match.confidence
	}

	/**
	 * The body of the matched span.
	 */
	public get value() {
		return this.span.body
	}

	/**
	 * The start index of the span.
	 */
	public get start() {
		return this.span.start
	}

	/**
	 * The end index of the span.
	 */
	public get end() {
		return this.span.end
	}

	/**
	 * The languages that the match was classified as.
	 */
	public get languages() {
		return this.#match.languages
	}

	/**
	 * The range of the span, i.e. the number of characters covered.
	 */
	public get coverage() {
		return this.span.coverage
	}

	constructor(span: Span, classification: ClassificationsMatchInput) {
		this.span = span

		this.#match =
			typeof classification === "string"
				? {
						classification,
						confidence: 1,
					}
				: classification
	}

	public toJSON(): SerializedSolutionMatch {
		return {
			...this.#match,
			value: this.span.body,
			start: this.span.start,
			end: this.span.end,
		}
	}
}

export function calculateRangeScore(match: SolutionMatch) {
	let range: number

	if (match.span.children.size) {
		range = Iterator
			// ---
			.from(match.span.children)
			.reduce((sum, child) => sum + (child.end - child.start), 0)
	} else {
		range = match.end - match.start
	}

	return {
		range,
		confidence: match.confidence * range,
	}
}
