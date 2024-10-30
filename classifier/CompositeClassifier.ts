/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ClassifierSchemeConfig, ClassifierSchemeCriteria } from "../classification/Classification.js"
import { Span } from "../tokenization/Span.js"
import SectionClassifier from "./super/SectionClassifier.js"

// @todo: scheme.scheme is a confusing API
// @todo: support scheme.scheme with a single element

// compute cartesian product of arrays
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

// const f = (a: any, b: any) => [].concat(...a.map((d: any) => b.map((e: any) => [].concat(d, e))))

// function cartesian(a: any, b: any, ...c: any[]): any[] {
// 	// @ts-expect-error Fix
// 	return b ? cartesian(f(a, b), ...c) : a
// }

class CompositeClassifier extends SectionClassifier {
	public schemes: ClassifierSchemeConfig[]

	constructor(schemes: ClassifierSchemeConfig[] = []) {
		super()
		this.schemes = schemes
	}

	match(scheme: ClassifierSchemeCriteria, phrase: Span) {
		const children = phrase.graph.findAll("child")

		// 'scheme.is' is a required property
		if (!Array.isArray(scheme.is)) {
			return false
		}

		// phrase doesn't include at least one of the target classifications
		if (!scheme.is.some((cl) => phrase.classifications.hasOwnProperty(cl))) {
			// this is a multi-word phrase
			if (children.length !== 1) {
				return false
			}
			// this is a single-word phrase, also check the classification of its single child
			if (!scheme.is.some((cl) => children[0]!.classifications.hasOwnProperty(cl))) {
				return false
			}
		}

		// 'scheme.not' is an optional property
		if (!Array.isArray(scheme.not)) {
			return true
		}

		// phrase does include at least one of the target classifications
		if (scheme.not.some((cl) => phrase.classifications.hasOwnProperty(cl))) {
			return false
		}

		// this is a single-word phrase, check the classification of it's single child
		if (children.length === 1) {
			if (scheme.not.some((cl) => children[0]!.classifications.hasOwnProperty(cl))) {
				return false
			}
		}

		return true
	}

	each(section: Span) {
		const phrases = section.graph.findAll("phrase")

		// sort phrases so shorter phrases are matched first
		// note: this mutates the original array
		phrases.sort((a, b) => a.norm.length - b.norm.length)

		for (const scheme of this.schemes) {
			// invalid scheme
			if (!Array.isArray(scheme.scheme)) continue

			// list of candidate matches for each scheme
			const candidates = scheme.scheme.map((s) => phrases.filter(this.match.bind(null, s)))

			// no candidates were found for one or more schemes
			if (candidates.some((c) => c.length === 0)) {
				continue
			}

			// compute composites (each with candidates of the same length as s.scheme)
			let composites: Span[][] = cartesian(...candidates)

			// remove any overlapping composites
			composites = composites.filter((c) => {
				for (let i = 0; i < c.length; i++) {
					const curr = c[i]!
					const next = c[i + 1]
					const prev = c[i - 1]

					// enforce adjacency
					if (
						next &&
						!curr.graph.findOne("child:last")!.graph.some("next", (s) => s === next.graph.findOne("child:first"))
					) {
						return false
					} else if (
						prev &&
						!curr.graph.findOne("child:first")?.graph.some("prev", (s) => s === prev.graph.findOne("child:last"))
					) {
						return false
					}

					// avoid adding tokens to the front of a street classification
					// that begins with a street prefix.
					// eg. 'A + Ave B' (ave is both a valid prefix & suffix)
					if (next && next.classifications.hasOwnProperty("StreetClassification")) {
						const firstChild = next.graph.findOne("child")
						if (firstChild && firstChild.classifications.hasOwnProperty("StreetPrefixClassification")) {
							return false
						}
					}
				}
				return true
			})

			// found no matches
			if (!composites.length) {
				continue
			}

			// optionally classify phrase
			if (typeof scheme.Class === "function") {
				// find phrases which equal the composites
				let superPhrases: Span[] = []

				composites.forEach((composite) => {
					const carr = Array.isArray(composite) ? composite : [composite] // cast to array
					const start = carr[0]!.start
					const end = carr[carr.length - 1]!.end

					superPhrases = superPhrases.concat(phrases.filter((p) => p.start === start && p.end === end))
				})

				// classify each super phrase
				superPhrases.forEach((superPhrase) => {
					// spread children langs to the parent
					const langs = superPhrase.graph.findAll("child").reduce(
						(acc, span) => {
							Object.values(span.classifications)
								.filter((c) => c.meta && c.meta.langs)
								.map((c) => Object.keys(c.meta.langs))
								.forEach((lang) => {
									// TODO: Is this correct?
									acc[lang.toString()] = true
								})
							return acc
						},
						{} as Record<string, boolean>
					)

					superPhrase.classify(new scheme.Class(scheme.confidence, { langs }))
				})

				// optionally classify individual phrases
				composites.forEach((spans) => {
					scheme.scheme.forEach((sch, i) => {
						if (typeof sch.Class === "function") {
							spans[i]!.classify(new sch.Class(sch.confidence))
						}
					})
				})
			}
		}
	}
}

export default CompositeClassifier
