/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "@mailwoman/core/tokenization"

import type { Classification } from "./Classification.js"
import { type ClassifierSchemeConfig, phraseMatchesScheme } from "./scheme.js"
import { SectionClassifier } from "./SectionClassifier.js"

/**
 * Compute the cartesian product of two or more arrays.
 *
 * A cartesian product is the set of all possible combinations of the elements.
 */
function cartesian<T>(...args: T[][]): T[][] {
	return args.reduce(
		(acc, val) => {
			const res: T[][] = []

			acc.forEach((a) => {
				val.forEach((b) => {
					res.push(a.concat([b]))
				})
			})

			return res
		},
		[[]] as T[][]
	)
}

export abstract class CompositeClassifier extends SectionClassifier {
	public schemes: ClassifierSchemeConfig[]
	public readonly primaryClassification: Classification

	constructor(primaryClassification: Classification, schemes: Iterable<ClassifierSchemeConfig>) {
		super()
		this.primaryClassification = primaryClassification
		this.schemes = Array.from(schemes)
	}

	public explore(section: Span): void {
		const { phrases } = section

		// Sort phrases so shorter phrases are matched first.
		section.phrases.sort((a, b) => a.normalized.length - b.normalized.length)

		for (const config of this.schemes) {
			const candidates = config.scheme.map((criteria) => {
				return Iterator.from(phrases)
					.filter((phrase) => phraseMatchesScheme(criteria, phrase))
					.toArray()
			})

			// no candidates were found for one or more schemes
			if (candidates.some((c) => c.length === 0)) {
				continue
			}

			// compute composites (each with candidates of the same length as s.scheme)
			const compositeSpans: readonly Span[][] = cartesian(...candidates)

			// remove any overlapping composites
			const adjacentComposites = compositeSpans.filter((composite) => {
				for (let i = 0; i < composite.length; i++) {
					const current = composite[i]!
					const firstChild = current.children.first
					const lastChild = current.children.last

					const next = composite[i + 1]
					const prev = composite[i - 1]

					if (!next && !prev) continue

					// Enforce adjacency.
					if (next && lastChild && !Iterator.from(lastChild.nextSiblings).some((s) => s === next.children.first)) {
						return false
					}

					if (prev && firstChild && !Iterator.from(firstChild.previousSiblings).some((s) => s === prev.children.last)) {
						return false
					}

					// Avoid adding tokens to the front of a street classification
					// that begins with a street prefix.
					// e.g. 'A + Ave B' (ave is both a valid prefix & suffix)
					if (next?.is("street") && next.children.first?.is("street_prefix")) {
						return false
					}
				}

				return true
			})

			if (!adjacentComposites.length) continue

			// find phrases which equal the composites
			let superPhrases: Span[] = []

			adjacentComposites.forEach((composites) => {
				const start = composites[0]!.start
				const end = composites[composites.length - 1]!.end

				superPhrases = superPhrases.concat(
					Iterator.from(phrases)
						.filter((p) => p.start === start && p.end === end)
						.toArray()
				)
			})

			// classify each super phrase
			superPhrases.forEach((superPhrase) => {
				const classification = config.classification ?? this.primaryClassification

				superPhrase.classifications.add({
					classification,
					confidence: config.confidence,
					languages: superPhrase.languages,
				})
			})

			// Optionally classify individual phrases
			for (const spans of adjacentComposites) {
				for (const [i, childScheme] of config.scheme.entries()) {
					if (!childScheme.classification) continue

					const span = spans[i]

					if (!span) continue

					span.classifications.add({
						classification: childScheme.classification,
						confidence: childScheme.confidence,
						languages: span.languages,
					})
				}
			}
		}
	}
}
