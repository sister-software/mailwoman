/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { SolverContext } from "@mailwoman/core"

export class OrphanedUnitTypeDeclassifier {
	solve(context: SolverContext): void {
		context.solutions = context.solutions.filter((solution) => {
			const unitType = solution.filter("unit_designator")

			if (unitType.length === 0) return true

			const unit = solution.filter("unit")

			if (unit.length === 0) {
				solution.matches = solution.findWithout("unit_designator")

				return solution.matches.length > 0
			}

			return true
		})
	}
}
