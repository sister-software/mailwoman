/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification } from "../classification/Classification.js"
import { Graph } from "./Graph.js"

const MAX_SPAN_LENGTH = 140

export interface ComputedSpanBody {
	numerals: boolean
	final: {
		period: boolean
	}
}

// TODO: Swap to map.
// public classifications = new Map<string, Classification>()
type ClassificationsMap = {
	[constructorName: string]: Classification
}

/**
 * A span of text, i.e. a token or a phrase.
 */
export class Span {
	public norm = ""

	/**
	 * The End index of the span
	 */
	public end = 0

	public classifications: ClassificationsMap = {}

	public graph = new Graph<Span>()

	public contains: ComputedSpanBody = {
		numerals: false,
		final: {
			period: false,
		},
	}

	static from(input?: string | Span) {
		if (input instanceof Span) {
			return input
		}

		return new Span(input)
	}

	constructor(
		public body = "",
		public start = 0
	) {
		this.setBody(body)
	}

	/**
	 * Set the body of the Span
	 */
	setBody(body = "") {
		this.body = body

		if (this.body.length > MAX_SPAN_LENGTH) {
			this.body = this.body.slice(0, MAX_SPAN_LENGTH)
		}

		this.norm = this.body.toLowerCase() // normalized body
		this.end = this.start + this.body.length

		// convenience booleans to avoid computing these in every classifier
		this.contains = {
			numerals: /\d/.test(this.body),
			final: {
				period: this.body.slice(-1) === ".",
			},
		}
	}

	/**
	 * Predicate to determine if this Span intersects another Span
	 */
	intersects(span: Span): boolean {
		return this.start < span.end && this.end > span.start
	}

	/**
	 * Predicate to determine if this Span covers another Span
	 */
	covers(span: Span): boolean {
		return this.start <= span.start && this.end >= span.end
	}

	/**
	 * Returns the distance between two Spans
	 *
	 * @todo Use graph to find prev and next spans for a more accurate result
	 *
	 * @todo Or base 'distance' on word distance (slop) rather than characters
	 */
	distance(span: Span): number {
		if (this.intersects(span)) {
			return 0
		}
		if (this.end < span.start) {
			return span.start - this.end
		} // $this is left
		return this.start - span.end // $this is right
	}

	/**
	 * Add a classification for this span
	 */
	classify(classification: Classification): Span {
		const constructorName = classification.constructor.name

		// ensure that duplicate classifications do not reduce confidence
		const existing = Object.hasOwn(this.classifications, constructorName) ? this.classifications[constructorName] : null

		if (existing && existing.confidence >= classification.confidence) {
			return this
		}

		this.classifications[constructorName] = classification

		return this
	}

	/**
	 * Set the children of this Span.
	 */
	setChildren(spans: Span[]) {
		for (const span of spans) {
			this.graph.add("child", span)
		}
		return this
	}

	/**
	 * Set the phrases of this Span.
	 */
	setPhrases(phrases: Span[]): Span {
		phrases.forEach((p) => this.graph.add("phrase", p), this)
		return this
	}

	/**
	 * Connect siblings in the graph.
	 */
	static connectSiblings(...spans: Span[]) {
		// Supports both var-args and Array as argument
		if (Array.isArray(spans[0])) {
			spans = spans[0]
		}

		for (const [i, span] of spans.entries()) {
			if (spans[i - 1]) {
				span.graph.add("prev", spans[i - 1]!)
			}

			if (spans[i + 1]) {
				span.graph.add("next", spans[i + 1]!)
			}
		}

		return spans
	}
}
