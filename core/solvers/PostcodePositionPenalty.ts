/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solver, SolverContext } from "@mailwoman/core"

const basePenalty = 0.1

/**
 * Applies a penalty to solutions where the postcode may have recieved a high score with an uncommon
 * position in the address.
 *
 * E.g. rua godinho de faria 1200
 */
export class PostcodePositionPenalty implements Solver {
	solve({ solutions }: SolverContext): void {
		for (const solution of solutions) {
			// Do nothing if the solution doesn't have a postcode classification
			const postcode = solution.find("postcode")
			if (!postcode) continue

			// Do nothing if the solution has a housenumber classification
			const housenumber = solution.find("house_number")
			if (housenumber) continue

			// Do nothing for solutions with either none or 2+ street classifications (intersections)
			const streetCount = solution.filter("street").length

			if (streetCount === 0 || streetCount >= 2) continue

			// apply a small penalty
			solution.penalty += basePenalty
		}
	}
}
