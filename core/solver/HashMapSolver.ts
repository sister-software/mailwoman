/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type Classification, isVisibleClassification } from "@mailwoman/core/classification"
import { Span, TokenContext } from "@mailwoman/core/tokenization"

import type { Solver } from "./BaseSolver.js"
import { Solution } from "./Solution.js"
import { SolutionMatch } from "./SolutionMatch.js"

export abstract class HashMapSolver implements Solver {
	static MaxMatchesPerClassification = 8

	abstract solve(context: TokenContext): void

	protected generateHashMap(
		context: TokenContext,
		includePrivate = false,
		includeEmpty = false
	): Map<Classification, Solution> {
		const classificationSolutionMap = new Map<Classification, Solution>()

		for (const section of context.sections) {
			// Multi-word phrases
			const { phrases } = section

			for (const phrase of phrases) {
				for (const match of phrase.classifications.values()) {
					if (!includePrivate && !isVisibleClassification(match)) {
						continue
					}

					let solution = classificationSolutionMap.get(match.classification)

					if (!solution) {
						solution = new Solution()
						classificationSolutionMap.set(match.classification, solution)

						if (includeEmpty) {
							solution.matches.push(new SolutionMatch(new Span(), match))
						}
					}

					if (solution.matches.length >= HashMapSolver.MaxMatchesPerClassification) {
						continue
					}

					solution.matches.push(new SolutionMatch(phrase, match))
				}
			}

			// Single-word spans.
			// TODO: combine with above loop, or refactor to avoid duplication.
			for (const word of section.children) {
				for (const classification of word.classifications.values()) {
					if (!includePrivate && !isVisibleClassification(classification)) {
						continue
					}

					let solution = classificationSolutionMap.get(classification.classification)

					if (!solution) {
						solution = new Solution()
						classificationSolutionMap.set(classification.classification, solution)

						if (includeEmpty) {
							solution.matches.push(new SolutionMatch(new Span(), classification))
						}
					}

					if (solution.matches.length >= HashMapSolver.MaxMatchesPerClassification) {
						continue
					}

					solution.matches.push(new SolutionMatch(word, classification))
				}
			}
		}

		return classificationSolutionMap
	}
}
