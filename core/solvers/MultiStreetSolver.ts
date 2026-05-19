/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type Classification, HashMapSolver, Solution, TokenContext } from "@mailwoman/core"

// classifications which are more granular than StreetClassification
// should not be included in intersection solutions.
const MORE_GRANULAR_THAN_STREET = new Set<Classification>([
	"house_number",
	"level",
	"level_designator",
	"unit",
	"unit_designator",
	"venue",
])

/**
 * If a 'multistreet' classification was detected then add a new solution which covers all streets
 * included.
 *
 * The ExclusiveCartesianSolver ensures that each public classification can exist only once per
 * solution (ie. we can't have two postalcodes).
 *
 * Intersections are the only exception to this rule, so rather than modifying the
 * ExclusiveCartesianSolver we use this solver to create the missing intersection solutions (those
 * with 2x 'street' labels).
 *
 * One of the challenges is that there could be many different interpretations of the admin tokens,
 * so we need to ensure that each of those permutations is also represented by a distinct
 * intersection solution.
 *
 * The solver works by iterating over existing solutions looking for any which identified a street,
 * it then clones that solution, removes any tokens less granular than street and attempts to add
 * the new street token in its place.
 *
 * Care is taken to ensure that the resulting solution does not contain tokens in overlapping
 * positions.
 */
export class MultiStreetSolver extends HashMapSolver {
	solve(context: TokenContext): void {
		const classificationSolutionMap = this.generateHashMap(context, true)
		const multistreet = classificationSolutionMap.get("multistreet")
		const street = classificationSolutionMap.get("street")

		if (!multistreet || multistreet.matches.length < 1) return

		if (!street || street.matches.length < 2) return

		// only currently consider one multistreet parse (for simplicity)
		// @todo: there may be some rare cases where we detect more than one?
		const [multi] = multistreet.matches

		if (!multi) return

		// generate a list of streets which intersect the multistreet
		const streets = street.matches.filter(({ span }) => span.intersects(multi.span))

		if (streets.length < 2) return

		// generate a list of candidate solutions which could potentially be
		// cloned to generate new intersection solutions
		let candidates = context.solutions.filter((solution) => {
			return solution.matches.some(({ span, classification }) => {
				return classification === "street" && span.intersects(multi.span)
			})
		})

		// truncate the candidates by making a copy of the current solution and removing all solution
		// matches which came before the street and also any matches less granular than street
		// (such as venue, housenumber etc.)
		candidates = candidates.map((solution) => {
			// find the street solution pair (there should be exactly one)
			const candidateStreet = solution.find("street")!

			// Remove some pairs from the solution.
			const truncated = solution.matches.filter(({ start, classification }) => {
				return start >= candidateStreet.span.start && !MORE_GRANULAR_THAN_STREET.has(classification)
			})

			return new Solution(truncated)
		})

		// the truncation step above can generate duplicate solutions so a 'content hash'
		// is generated in order to deduplicate them.
		// note: this is purely a performance optimization as it generates fewer candidates

		candidates = uniqBy(candidates, (truncated) => {
			return truncated.matches.map(({ span, classification }) => `${classification}:${span.normalized}`).join("_")
		})

		// iterate over candidates and generate new intersection solutions
		const intersectionSolutions: Solution[] = candidates.flatMap((truncated) => {
			// find all street classsifications which intersect the 'multistreet' span
			// and also do not overlap an existing pair in this solution.
			return streets
				.filter((candidateStreet) => {
					return truncated.matches.every(({ span }) => !span.intersects(candidateStreet.span))
				})
				.flatMap((candidateStreet) => {
					// Copy of the truncated solution and add the additional street.

					return new Solution([...truncated.matches, candidateStreet])
				})
		})

		context.solutions = [...context.solutions, ...intersectionSolutions]
	}
}

function uniqBy<T>(arr: T[], predicate: (o: T) => unknown): T[] {
	const pickedObjects = arr
		.filter(Boolean)
		.reduce((map, item) => {
			const key = predicate(item)

			if (!key) return map

			return map.has(key) ? map : map.set(key, item)
		}, new Map())
		.values()

	return Array.from(pickedObjects)
}
