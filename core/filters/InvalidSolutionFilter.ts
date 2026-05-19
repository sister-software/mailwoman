/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Classification, Solver, SolverContext } from "@mailwoman/core"

type InvalidSequence = Classification[]

/**
 * Filter to remove combinations of classifications that don't logically make sense.
 *
 * For example, removing solutions which are only 'house_number+locality'
 */
export class InvalidSolutionFilter implements Solver {
	public readonly invalidSequences: InvalidSequence[]

	constructor(...invalidSequences: InvalidSequence[]) {
		this.invalidSequences = invalidSequences.map((invalidCombination) => invalidCombination.sort())
	}

	solve(tokenizer: SolverContext): void {
		const nextSolutions = tokenizer.solutions.filter((solution) => {
			const classifications = solution.collectClassifications().sort()

			return !this.invalidSequences.some((p) => {
				if (classifications.length !== p.length) return false

				const invalid = classifications.every((_, i) => classifications[i] === p[i])

				return invalid
			})
		})

		tokenizer.solutions = nextSolutions
	}
}
