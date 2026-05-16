/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SolverContext } from "@mailwoman/core"

export class OrphanedLevelTypeDeclassifier {
	solve(context: SolverContext): void {
		context.solutions = context.solutions.filter((solution) => {
			const levelType = solution.filter("level_designator")

			if (levelType.length === 0) return true

			const level = solution.filter("level")

			if (level.length === 0) {
				solution.matches = solution.findWithout("level_designator")

				return solution.matches.length > 0
			}

			return true
		})
	}
}
