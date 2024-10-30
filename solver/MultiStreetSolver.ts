/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Tokenizer } from "../tokenization/Tokenizer.js"
import HashMapSolver from "./super/HashMapSolver.js"

// classifications which are more granular than StreetClassification
// should not be included in intersection solutions.
const MORE_GRANULAR_THAN_STREET = [
	"HouseNumberClassification",
	"LevelClassification",
	"LevelTypeClassification",
	"UnitClassification",
	"UnitTypeClassification",
	"VenueClassification",
]

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

class MultiStreetSolver extends HashMapSolver {
	solve(tokenizer: Tokenizer) {
		const map = this.generateHashMap(tokenizer, true)
		const multistreet = map.get("multistreet")
		const street = map.get("street")

		// sanity checking
		if (!multistreet || multistreet.pair.length < 1) {
			return
		}

		if (!street || street.pair.length < 2) {
			return
		}

		// only currently consider one multistreet parse (for simplicity)
		// @todo: there may be some rare cases where we detect more than one?
		const multi = multistreet.pair[0]

		if (!multi) return

		// generate a list of streets which intersect the multistreet
		const streets = street.pair.filter((s) => s.span.intersects(multi.span))
		if (streets.length < 2) {
			return
		}

		// generate a list of candidate solutions which could potentially be
		// cloned to generate new intersection solutions
		let candidates = tokenizer.solutions.filter((solution) => {
			// candidate solution must contain a street and also that street
			// must intersect the multistreet classification.
			return solution.pair.some(
				(s) => s.classification.constructor.name === "StreetClassification" && s.span.intersects(multi.span)
			)
		})

		// truncate the candidates by making a copy of the current solution and removing all solution
		// pairs which came before the street and also any pairs less granular than street
		// (such as venue, housenumber etc.)
		candidates = candidates.map((solution) => {
			// find the street solution pair (there should be exactly one)
			const candidateStreet = solution.pair.find((s) => s.classification.constructor.name === "StreetClassification")!

			// remove some pairs from the solution
			const truncated = solution.copy()

			truncated.pair = truncated.pair.filter((s) => {
				return (
					s.span.start >= candidateStreet.span.start &&
					!MORE_GRANULAR_THAN_STREET.includes(s.classification.constructor.name)
				)
			})

			return truncated
		})

		// the truncation step above can generate duplicate solutions so a 'content hash'
		// is generated in order to deduplicate them.
		// note: this is purely a performance optimization as it generates fewer candidates

		candidates = uniqBy(candidates, (truncated) => {
			return truncated.pair.map((p) => `${p.classification.label}:${p.span.norm}`).join("_")
		})

		// iterate over candidates and generate new intersection solutions
		candidates.forEach((truncated) => {
			// find all street classsifications which intersect the 'multistreet' span
			// and also do not overlap an existing pair in this solution.
			streets.forEach((candidateStreet) => {
				if (truncated.pair.every((p) => !p.span.intersects(candidateStreet.span))) {
					// make a copy of the truncated solution and add the additional street
					const intersection = truncated.copy()
					intersection.pair.push(candidateStreet)

					// append this solution
					tokenizer.solutions.push(intersection)
				}
			})
		})
	}
}

export default MultiStreetSolver

function uniqBy<T>(arr: T[], predicate: (o: T) => any): T[] {
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
