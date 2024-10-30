/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span } from "../../tokenization/Span.js"
import { Tokenizer } from "../../tokenization/Tokenizer.js"
import Solution from "../Solution.js"
import SolutionPair from "../SolutionPair.js"
import { Solver } from "./BaseSolver.js"
const MAX_PAIRS_PER_LABEL = 8

abstract class HashMapSolver implements Solver {
	abstract solve(tokenizer: Tokenizer): void

	generateHashMap(tokenizer: Tokenizer, includePrivate = false, includeEmpty = false): Map<string, Solution> {
		const map = new Map<string, Solution>()

		for (const section of tokenizer.section) {
			// multi-word phrases
			const phrases = section.graph.findAll("phrase")

			for (const phrase of phrases) {
				const keys = Object.keys(phrase.classifications)

				if (!keys.length) continue

				for (const classification of Object.values(phrase.classifications)) {
					if (!includePrivate && !classification.public) {
						continue
					}

					let solution = map.get(classification.label)

					if (!solution) {
						solution = new Solution()
						map.set(classification.label, solution)

						if (includeEmpty) {
							solution.pair.push(new SolutionPair(new Span(), classification))
						}
					}

					if (solution.pair.length >= MAX_PAIRS_PER_LABEL) {
						continue
					}

					solution.pair.push(new SolutionPair(phrase, classification))
				}
			}

			// single-word spans
			const children = section.graph.findAll("child")

			for (const word of children) {
				const keys = Object.keys(word.classifications)
				if (!keys.length) {
					continue
				}

				for (const classification of Object.values(word.classifications)) {
					if (!includePrivate && !classification.public) {
						continue
					}

					let solution = map.get(classification.label)

					if (!solution) {
						solution = new Solution()
						map.set(classification.label, solution)

						if (includeEmpty) {
							solution.pair.push(new SolutionPair(new Span(), classification))
						}
					}

					if (solution.pair.length >= MAX_PAIRS_PER_LABEL) {
						continue
					}

					solution.pair.push(new SolutionPair(word, classification))
				}
			}
		}

		return map
	}
}

export default HashMapSolver
