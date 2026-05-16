/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solver, SolverContext } from "@mailwoman/core"

export class SubsetFilter implements Solver {
	solve(context: SolverContext): void {
		for (const [i, solution] of context.solutions.entries()) {
			context.solutions = context.solutions.filter((s, j) => {
				if (j <= i) {
					return true
				}

				// do not favour solutions with lower scores (if for any reason they are not sorted)
				if (solution.score < s.score) {
					return false
				}

				// if two solutions cover the same tokens, remove the latter
				if (solution.coversSameClassification(s)) {
					return false
				}

				return true
			})
		}
	}
}
