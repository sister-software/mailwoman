/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"
import Solution from "./Solution.js"
import HashMapSolver from "./super/HashMapSolver.js"
const MAX_RECURSION = 10
const MAX_SOLUTIONS = 50000

class ExclusiveCartesianSolver extends HashMapSolver {
	solve(tokenizer: Tokenizer) {
		const map = this.generateHashMap(tokenizer, false, true)
		const solutions = Array.from(map.values()).reverse()

		const exclusiveSolutions = ExclusiveCartesianSolver.exclusiveCartesian(...solutions)

		tokenizer.solutions = tokenizer.solutions.concat(exclusiveSolutions)
	}

	// compute the unique cartesian product
	// (all permutations of non-overlapping tokens from different classifications)
	static exclusiveCartesian(...args: Solution[]): Solution[] {
		let r: Solution[] = []

		const max = args.length - 1

		if (!args.length) {
			return r
		}

		const helper = (currentSolution: Solution, solutionIndex: number) => {
			const referencedSolution = args[solutionIndex]!

			for (let pairIndex = 0, l = referencedSolution.pair.length; pairIndex < l; pairIndex++) {
				const copy = currentSolution.copy() // clone solution

				if (referencedSolution.pair[pairIndex]?.span.body.length) {
					copy.pair.push(referencedSolution.pair[pairIndex]!)
				}

				if (solutionIndex === max) {
					if (copy.pair.length && r.length < MAX_SOLUTIONS) {
						r.push(copy)
					}
				} else if (solutionIndex < MAX_RECURSION) {
					helper(copy, solutionIndex + 1)
				}
			}
		}
		helper(new Solution(), 0)

		// reverse order
		r = r.reverse()

		// do not add a pair where the span intersects an existing pair
		r = r.filter((s) => {
			return !s.pair.some((p1, i1) => {
				return s.pair.some((p2, i2) => {
					if (i2 <= i1) {
						return false
					}
					return p1.span.intersects(p2.span)
				})
			})
		})

		return r
	}
}

export default ExclusiveCartesianSolver
