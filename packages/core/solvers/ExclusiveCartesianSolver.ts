/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { HashMapSolver, Solution, TokenContext } from "@mailwoman/core"
const MAX_RECURSION = 10
const MAX_SOLUTIONS = 50000

export class ExclusiveCartesianSolver extends HashMapSolver {
	solve(context: TokenContext): void {
		const map = this.generateHashMap(context, false, true)
		const solutions = Array.from(map.values()).reverse()

		const exclusiveSolutions = ExclusiveCartesianSolver.exclusiveCartesian(...solutions)

		context.solutions = context.solutions.concat(exclusiveSolutions)
	}

	// compute the unique cartesian product
	// (all permutations of non-overlapping tokens from different classifications)
	static exclusiveCartesian(...solutions: Solution[]): Solution[] {
		let results: Solution[] = []

		const max = solutions.length - 1

		if (!solutions.length) return results

		const explore = (currentSolution: Solution, solutionIndex: number): void => {
			const referencedSolution = solutions[solutionIndex]!

			for (let pairIndex = 0, l = referencedSolution.matches.length; pairIndex < l; pairIndex++) {
				const copy = new Solution(Iterator.from(currentSolution.matches))

				if (referencedSolution.matches[pairIndex]?.span.body.length) {
					copy.matches.push(referencedSolution.matches[pairIndex]!)
				}

				if (solutionIndex === max) {
					if (copy.matches.length && results.length < MAX_SOLUTIONS) {
						results.push(copy)
					}
				} else if (solutionIndex < MAX_RECURSION) {
					explore(copy, solutionIndex + 1)
				}
			}
		}
		explore(new Solution(), 0)

		// Reverse order, so that the most granular classifications are at the end.
		results = results.reverse()

		// Do not add a pair where the span intersects an existing pair
		// i.e. we can't have two postal codes in the same solution.

		results = results.filter((s) => {
			return !s.matches.some((p1, i1) => {
				return s.matches.some((p2, i2) => {
					if (i2 <= i1) return false

					return p1.span.intersects(p2.span)
				})
			})
		})

		return results
	}
}

export default ExclusiveCartesianSolver
