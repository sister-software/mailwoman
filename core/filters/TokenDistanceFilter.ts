/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Solver, SolverContext } from "@mailwoman/core"

const MAX_DISTANCE = 2

export class TokenDistanceFilter implements Solver {
	solve(context: SolverContext): void {
		context.solutions = context.solutions.filter((solution) => {
			const housenumber = solution.filter("house_number")
			const street = solution.filter("street")

			// Housenumber with no street
			// note: remove this as a postcode classification may be more relevant
			// note: this functionality may no longer be valid in an autocomplete context
			if (housenumber.length > 0 && street.length === 0) {
				solution.matches = solution.findWithout("house_number")

				return solution.matches.length > 0
			}

			// Both house number and street classified.
			if (housenumber.length > 0 && street.length > 0) {
				// Ensure tokens are less than n distance apart.
				if (street[0]!.span.distance(housenumber[0]!.span) > MAX_DISTANCE) {
					return false
				}
			}

			return true
		})
	}
}
