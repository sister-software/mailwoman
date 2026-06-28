/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

// Imported via deep relative path (not @mailwoman/core/classification) to avoid a runtime cycle:
// classification/index.ts re-exports SectionClassifier / WordClassifier which themselves import
// Span from @mailwoman/core/tokenization, creating a TDZ that surfaces as "Class extends value
// undefined" when the source-mode test runner loads tokenization first.
import {
	type Classification,
	type ClassificationMatch,
	ClassificationsMatchMap,
} from "../classification/Classification.js"
import type { Displayable } from "../resources/debugging.js"
import type { Alpha3bLanguageCode } from "../resources/languages/index.js"
import type { LibPostalLanguageCode } from "../resources/libpostal.js"
import { Graph } from "./Graph.js"

const MAX_SPAN_LENGTH = 140

export interface SpanCreationOptions {
	start?: number
	classifications?: Iterable<Classification>
	children?: Iterable<Span>
}

const kSpanID: unique symbol = Symbol("SpanID")

export interface SerializedSpan {
	// [kSpanID]: number
	body: string
	start: number
	end: number
	normalized: string
	classifications: ClassificationMatch[]
	children: SerializedSpan[]
	phrases: SerializedSpan[]
}

/**
 * A span of text, i.e. a token or a phrase.
 */
export class Span extends Graph<Span> {
	#body: string = ""
	/**
	 * The start index of the span.
	 */
	public start: number

	/**
	 * The end index of the span.
	 */
	public end!: number

	/**
	 * The unique identifier for this span.
	 */
	protected static IDCounter = 0

	/**
	 * The unique identifier for this span.
	 */
	readonly [kSpanID]!: number

	public get id(): number {
		return this[kSpanID]
	}

	/**
	 * The normalized body of the span.
	 */
	public normalized = ""

	/**
	 * Classifications for this span.
	 */
	public readonly classifications: ClassificationsMatchMap = new ClassificationsMatchMap()

	readonly #flags = new Set<SpanFlag>()

	/**
	 * Boolean-like indications that hint at the nature of the span.
	 *
	 * Unlike classifications, these are not exposed in the final output.
	 */
	public get flags(): ReadonlySet<SpanFlag> {
		return this.#flags
	}

	public is(classification: Classification): boolean {
		return this.classifications.has(classification)
	}

	static from(input?: string, options?: SpanCreationOptions): Span
	static from(input: Span, options?: Omit<SpanCreationOptions, "start">): Span
	static from(input: Span | string, options?: SpanCreationOptions): Span
	static from(input: Span | string = "", options: SpanCreationOptions = {}): Span {
		const span = input instanceof Span ? input : new Span(input, options.start)

		for (const classification of options.classifications ?? []) {
			span.classifications.add(classification)
		}

		span.children.add(...(options.children ?? []))

		return span
	}

	constructor(body = "", start = 0) {
		super()

		// this[kSpanID] = Span.IDCounter++
		Object.defineProperty(this, kSpanID, {
			value: Span.IDCounter++,
			writable: false,
			enumerable: false,
			configurable: false,
		})

		// Note that `start` should be set first to ensure that `end` is calculated correctly.
		this.start = start
		this.body = body
	}

	get body(): string {
		return this.#body
	}

	/**
	 * Set the body of the Span
	 */
	set body(nextBody: string) {
		this.#flags.clear()
		this.#body = nextBody.slice(0, MAX_SPAN_LENGTH)

		this.normalized = this.#body.toLowerCase()
		this.end = this.start + this.#body.length

		for (const [pattern, flag] of PatternMatchers) {
			if (pattern.test(this.normalized)) {
				this.#flags.add(flag)

				break
			}
		}

		if (this.flags.has("numeric") || this.flags.has("alphanumeric")) {
			this.#flags.add("numeral")
		}

		if (this.#body.slice(-1) === ".") {
			this.#flags.add("ends_with_period")
		}
	}

	/**
	 * Predicate to determine if this Span intersects another Span
	 */
	public intersects(that: Pick<Span, "start" | "end">): boolean {
		return this.start < that.end && this.end > that.start
	}

	/**
	 * Predicate to determine if this Span covers another Span
	 */
	public covers(that: Pick<Span, "start" | "end">): boolean {
		return this.start <= that.start && this.end >= that.end
	}

	/**
	 * Returns the distance between two Spans
	 *
	 * @todo Use graph to find prev and next spans for a more accurate result
	 * @todo Or base 'distance' on word distance (slop) rather than characters
	 */
	public distance(that: Pick<Span, "start" | "end">): number {
		if (this.intersects(that)) return 0

		if (this.end < that.start) {
			return that.start - this.end
		}

		return this.start - that.end
	}

	/**
	 * Returns the coverage of the span, i.e. the number of characters covered by the span and its children.
	 */
	public get coverage(): number {
		if (this.children.size) {
			return (
				Iterator
					// ---
					.from(this.children)
					.reduce((sum, child) => sum + (child.end - child.start), 0)
			)
		}

		return this.end - this.start
	}

	/**
	 * The combined languages of the span's children.
	 */
	public get languages(): Displayable<ReadonlySet<LibPostalLanguageCode | Alpha3bLanguageCode>> {
		// Spread children langs to the parent...
		const languages: Displayable<Set<LibPostalLanguageCode | Alpha3bLanguageCode>> = new Set()
		const displayNames = new Set<string>()

		for (const child of this.children) {
			for (const classification of child.classifications.values()) {
				const childLanguages = classification.languages

				if (!childLanguages) continue

				if (childLanguages.displayName) {
					displayNames.add(childLanguages.displayName)
				}

				for (const language of childLanguages) {
					languages.add(language)
				}
			}
		}

		languages.displayName = displayNames.size ? Array.from(displayNames).join(", ") : undefined

		return languages
	}

	/**
	 * Serialize the span to JSON.
	 */
	public toJSON(): SerializedSpan {
		return {
			// [kSpanID]: this.id,
			body: this.body,
			start: this.start,
			end: this.end,
			normalized: this.normalized,
			classifications: this.classifications.toJSON(),
			children: Iterator.from(this.children)
				.map((c) => c.toJSON())
				.toArray(),
			phrases: Iterator.from(this.phrases)
				.map((p) => p.toJSON())
				.toArray(),
		} satisfies SerializedSpan
	}

	public override toString() {
		const classifications = Array.from(this.classifications.keys()).join(", ")
		const flags = Array.from(this.#flags).join(", ")

		return `Span(${this.children.size}) "${this.body}" [${classifications}][${flags}]`
	}

	public [Symbol.for("nodejs.util.inspect.custom")]() {
		return this.toString()
	}

	/**
	 * Connect siblings in the graph.
	 */
	static connectSiblings(...spans: Span[]) {
		for (const [i, span] of spans.entries()) {
			if (spans[i - 1]) {
				span.previousSiblings.add(spans[i - 1]!)
			}

			if (spans[i + 1]) {
				span.nextSiblings.add(spans[i + 1]!)
			}
		}

		return spans
	}
}

export type SpanFlag = "ends_with_period" | "numeric" | "alpha" | "alphanumeric" | "numeral" | "punctuation"

/**
 * Patterns to test and apply classifications to spans.
 *
 * Note that order here is important, as the first pattern that matches will be used.
 */
export const PatternMatchers: readonly [pattern: RegExp, flag: SpanFlag][] = [
	// Entirely numeric, i.e. contains only digits.
	[/^\d+$/, "numeric"],

	// Entirely special characters, i.e. contains only punctuation, symbols, or other non-alphanumeric characters.
	[/^[@&/\\#,+()$~%.!^'";:*?[\]<>{}]+$/, "punctuation"],

	// Entirely alpha, i.e. contains only letters.
	[/^[A-Za-z\W]+$/, "alpha"],

	// Entirely alphanumeric, i.e. contains only letters and digits.
	[/^[A-Za-z0-9\W]+$/, "alphanumeric"],
]
