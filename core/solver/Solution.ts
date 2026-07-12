/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	type Classification,
	type ClassificationConfidenceMap,
	type ClassificationMap,
	type ClassificationRecord,
	isVisibleClassification,
} from "@mailwoman/core/classification"
import type { TokenContext } from "@mailwoman/core/tokenization"

import { type SerializedSolutionMatch, SolutionMatch } from "./SolutionMatch.ts"

export interface SerializedSolution {
	score: number
	penalty: number
	classifications: ClassificationRecord
	matches: SerializedSolutionMatch[]
}

export interface SolutionCreationOptions {
	context: TokenContext
	matches?: SolutionMatch[]
}

export class Solution {
	public matches: SolutionMatch[]

	/**
	 * All classification in the solution.
	 */
	public collectClassifications(): Classification[] {
		return this.matches.map((pair) => pair.classification)
	}

	/**
	 * Find the first matching pair in the solution by its classification.
	 */
	public find(classification: Classification): SolutionMatch | undefined {
		return this.matches.find((pair) => pair.classification === classification)
	}

	/**
	 * Exclude match by classification.
	 */
	public findWithout(classification: Classification): SolutionMatch[] {
		return this.matches.filter((pair) => pair.classification !== classification)
	}

	/**
	 * Filter match by classification.
	 */
	public filter(classification: Classification): SolutionMatch[] {
		return this.matches.filter((pair) => pair.classification === classification)
	}

	/**
	 * Absolute score of the solution.
	 */
	public score = 0

	/**
	 * Penalty for the solution. This is used to penalize solutions that are not complete.
	 */
	public penalty = 0

	/**
	 * Create a new solution.
	 */
	constructor(matches: Iterable<SolutionMatch> = []) {
		this.matches = Array.from(matches)
	}

	/**
	 * Predicate to determine if this solution covers another solution, i.e. the target solution is a subset of this
	 * solution without any unique ranges.
	 */
	covers(that: Solution): boolean {
		return that.matches.every((pair) => this.matches.some(({ span }) => span.covers(pair.span)))
	}

	/**
	 * Predicate to determine if a solution covers another solution with the same classification.
	 */
	coversSameClassification(that: Solution): boolean {
		const result = that.matches.every((pair) =>
			this.matches.some(({ classification, span }) => {
				return classification === pair.classification && span.covers(pair.span)
			})
		)

		return result
	}

	computeScore(contextCoverage: number): void {
		const total = {
			coverage: 0,
			confidence: 0,
		}

		this.matches.forEach((match) => {
			const { confidence, coverage } = match

			// Total characters covered.
			total.coverage += coverage

			// Confidence of match multiplied by characters covered.
			total.confidence += confidence * coverage
		})

		// The average character score covered divided by the total coverage.
		this.score = (total.confidence / total.coverage) * (total.coverage / contextCoverage) * (1.0 - this.penalty)
	}

	/**
	 * @returns JSON representation of a solution
	 */
	public toJSON(): SerializedSolution {
		const { matches, score, penalty } = this
		const classificationIDMap: ClassificationMap = new Map()
		const classificationConfidences: ClassificationConfidenceMap = new Map()

		for (const { classification, confidence, span } of matches) {
			if (!isVisibleClassification(classification)) continue

			let bodies = classificationIDMap.get(classification)

			if (!bodies) {
				bodies = []
				classificationIDMap.set(classification, bodies)
			}

			bodies.push(span.body)

			classificationConfidences.set(classification, confidence)
		}

		const serialized: SerializedSolution = {
			score: parseFloat(score.toFixed(2)),
			penalty: parseFloat(penalty.toFixed(2)),
			classifications: Object.fromEntries(classificationIDMap) as ClassificationRecord,
			matches: matches.map((match) => match.toJSON()),
		}

		return serialized
	}
}

/**
 * Compare solutions for sorting, first by score, then by classification.
 */
export function rankingSolutionsByAreaClassification(a: Solution, b: Solution): number {
	if (b.score !== a.score) {
		return b.score - a.score
	}

	// Enforce a slight penalty for administrative ordering.

	const areaA = a.matches.find(({ span }) => span.is("area"))
	const areaB = b.matches.find(({ span }) => span.is("area"))

	const classification = {
		a: areaA?.classification,
		b: areaB?.classification,
	} as const satisfies Record<"a" | "b", Classification | undefined>

	if (classification.a === "locality") return -1

	if (classification.b === "locality") return 1

	if (classification.a === "region") return -1

	if (classification.b === "region") return 1

	if (classification.a === "country") return -1

	if (classification.b === "country") return 1

	// sort results by score desc
	return b.score - a.score
}
